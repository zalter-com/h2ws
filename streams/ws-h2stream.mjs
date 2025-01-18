import {EventEmitter} from "node:events";
import http2 from "node:http2";
import {concatTypedArrays} from "../utils/concat-typed-arrays.mjs";

http2.constants.HTTP2_HEADER_WS_PROTO = "sec-websocket-protocol";

const FastBuffer = Buffer[Symbol.species];

/**
 * A class that represents a WebSocket stream over an HTTP/2 stream.
 * @extends EventEmitter
 * @emits frame - When a complete frame is received. The event handler receives an object with the following detail properties: opcode, type, payload.
 * @emits pong - When a pong frame is received. The system ignores the payload.
 * @emits ping - When a ping frame is received. The system sends a pong frame in response. All payloads are ignored.
 * @emits error - When an error occurs. The event handler receives the error object.
 * @emits end - When the stream ends.
 * @emits close - When the stream is closed.
 */
export class WsH2Stream extends EventEmitter {
	static #acceptedProtocols = [];
	static set acceptedProtocols(protocols){
		WsH2Stream.#acceptedProtocols = protocols;
	}
	static get acceptedProtocols(){
		return [].concat(WsH2Stream.#acceptedProtocols);
	}
	static #WS_CONSTANTS = {
		OPCODES: {
			CONTINUATION: 0,
			TEXT: 1,
			BINARY: 2,
			CLOSE: 8,
			PING: 9,
			PONG: 10
		},
		FIRST_BYTE: {
			FINAL: 0b10000000,
			RSV1: 0b01000000,
			RSV2: 0b00100000,
			RSV3: 0b00010000,
		}
	}


	#stream = null;
	#incomingHeaders = {};
	#logger = console;
	#server = null;
	#session = null;
	#currentFrameFragments = [];
	/**
	 * The list of protocols requested by the client in the websocket initialisation.
	 * @type {Array<string>}
	 */
	#requestedWsProtocols = null;

	/**
	 * The listener for the data event. Does basic parsing and buffering of frame fragments.
	 * @param fragment
	 * @returns {{rsv2: number, rsv1: number, isFinal: number, rsv3: number, opcode: number}}
	 */
	static #fragmentInterpreter (fragment) {
		let fastFragment = (fragment instanceof FastBuffer) ? fragment : (new FastBuffer(fragment));
		if(fastFragment.length === 0){
			return;
		}
		const fragmentDetails = {
			isFinal: fastFragment[0] & 0b10000000,
			rsv1: fastFragment[0] & 0b01000000,
			rsv2: fastFragment[0] & 0b00100000,
			rsv3: fastFragment[0] & 0b00010000,
			opcode: fastFragment[0] & 0b00001111,
		}
		let currentOffset = 2;
		const payloadLength = fastFragment[1] & 0b01111111;
		switch (payloadLength){
			case 126:
				fragmentDetails.payloadLength = new Uint16Array(new Uint8Array(fastFragment.slice(2, 4)))[0];
				currentOffset += 2;
				break;
			case 127:
				fragmentDetails.payloadLength = new BigUint64Array(new Uint8Array(fastFragment.slice(2, 10)).buffer)[0];
				currentOffset += 8;
				break;
			default:
				fragmentDetails.payloadLength = payloadLength;
				// currentOffset += 0;
		}

		const usesMasking = fastFragment[1] & 0b10000000;
		if(usesMasking){
			fragmentDetails.maskingKey = Uint8Array.from(fastFragment.slice(currentOffset, currentOffset + 4));
			fragmentDetails.usesMasking = true;
			currentOffset += 4;
		}
		fragmentDetails.payload = fastFragment.slice(currentOffset);
		return fragmentDetails;
	}

	#sendFrame(options){
		switch (options.opcode){
			case WsH2Stream.#WS_CONSTANTS.OPCODES.CLOSE:
				this.#stream.write(Buffer.from([
					WsH2Stream.#WS_CONSTANTS.FIRST_BYTE.FINAL | WsH2Stream.OPCODES.CLOSE,
					0 // length 0
				]));
				break;
			case WsH2Stream.#WS_CONSTANTS.OPCODES.PING:
				this.#stream.write(Buffer.from([
					WsH2Stream.#WS_CONSTANTS.FIRST_BYTE.FINAL | WsH2Stream.OPCODES.PING,
					0 // IGNORE PAYLOAD!!!!
				]));
				break;
			case WsH2Stream.#WS_CONSTANTS.OPCODES.PONG:
				this.#stream.write(Buffer.from([
					WsH2Stream.#WS_CONSTANTS.FIRST_BYTE.FINAL | WsH2Stream.OPCODES.PONG,
					0 // IGNORE PAYLOAD!!!!
				]));
				break;
			case WsH2Stream.#WS_CONSTANTS.OPCODES.TEXT:
			case WsH2Stream.#WS_CONSTANTS.OPCODES.BINARY:
				const payloadLength = options.payload.length;
				let payloadLengthBytes;
				// TODO Implement fragmentation based on the payload length and the max frame size
				if(payloadLength < 126){
					payloadLengthBytes = Buffer.from([payloadLength]);
				}else if(payloadLength < 65536){
					payloadLengthBytes = Buffer.from([126, ...new Uint16Array([payloadLength])]);
				}else{
					payloadLengthBytes = Buffer.from([127, ...new BigUint64Array([BigInt(payloadLength)])]);
				}
				this.#stream.write(Buffer.concat([
					Buffer.from([WsH2Stream.#WS_CONSTANTS.FIRST_BYTE.FINAL | options.opcode]),
					payloadLengthBytes,
					options.payload
				]));
				break;
		}
	}

	/**
	 * Parses the frame fragments and emits the frame event when a complete frame is received.
	 * If it encounters a control frame it processes it immediately as per the WebSocket RFC and removes its fragment
	 * from the current frame fragments.
	 * ALL control frames should be in single fragments.
	 */
	#parseFrame(){
		// check whether the frame is a final frame
		const lastFragment = this.#currentFrameFragments[this.#currentFrameFragments.length - 1];
		// if the fragment is not final then we should wait for the next fragment
		if(!lastFragment.isFinal){
			return;
		}
		// if it's a control frame then it needs to be acted upon immediately
		if(lastFragment.opcode >= 8){
			switch (lastFragment.opcode){
				case WsH2Stream.#WS_CONSTANTS.OPCODES.CLOSE:
					this.#logger.debug("Close frame received.");
					this.#stream.end();
					break;
				case WsH2Stream.#WS_CONSTANTS.OPCODES.PING:
					this.#logger.debug("Ping received.");
					this.pong();
					break;
				case WsH2Stream.#WS_CONSTANTS.OPCODES.PONG:
					this.#logger.debug("Pong received.");
					this.emit('pong', lastFragment.payload);
					break;
				default:
					this.#logger.error("Unknown opcode", lastFragment.opcode);
					this.#stream.end();
					break;
			}
			this.#currentFrameFragments.pop();// Pop the last fragment as it's a control frame
			return;
		}
		// If the fragment is the final one then we can parse the frame
		const frameDetails = {
			opcode: this.#currentFrameFragments[0].opcode, // first fragment is the one containing the actual opcode
			type: this.#currentFrameFragments[0].opcode === WsH2Stream.#WS_CONSTANTS.OPCODES.TEXT ? "text" : this.#currentFrameFragments[0].opcode === WsH2Stream.#WS_CONSTANTS.OPCODES.BINARY ? "binary" : "unknown",
			payload: concatTypedArrays(this.#currentFrameFragments.map(
					fragment => fragment.usesMasking ?
							fragment.payload.map((byte, index) => byte ^ fragment.maskingKey[index % 4]) :
							fragment.payload
			))
		};
		frameDetails.payload = frameDetails.type === "text" ?
				Buffer.from(frameDetails.payload.buffer).toString("utf8") : frameDetails.payload;
		this.#logger.debug("Frame received", frameDetails);
		this.emit('frame', frameDetails);
		this.#currentFrameFragments = [];
	}

	/**
	 * Sends a ping frame on the websocket connection.
	 * A pong frame is expected in response.
	 */
	ping(){
		this.#sendFrame({
			opcode: WsH2Stream.#WS_CONSTANTS.OPCODES.PONG
		});
	}

	/**
	 * Sends a pong frame on the websocket connection. This should always be in response to a ping frame.
	 * Should never send a pong frame without having received a ping frame first.
	 */
	pong(){
		this.#sendFrame({
			opcode: WsH2Stream.#WS_CONSTANTS.OPCODES.PONG
		});
	}

	/**
	 * Sends a binary frame on the websocket connection.
	 * @param {Buffer} data - The data to send.
	 */
	sendBinary(data){
		if(!data instanceof FastBuffer || data instanceof Buffer || data instanceof Uint8Array.prototype){
			throw new TypeError("Data must be a Buffer or FastBuffer.");
		}
		this.#sendFrame({
			opcode: WsH2Stream.#WS_CONSTANTS.OPCODES.BINARY,
			payload: data?.buffer || data
		});
	}

	/**
	 * Sends a text frame on the websocket connection.
	 * @param data
	 */
	sendText(data){
		this.#sendFrame({
			opcode: WsH2Stream.#WS_CONSTANTS.OPCODES.TEXT,
			payload: Buffer.from(data)
		});
	}

	/**
	 * Creates a new WebSocket stream.
	 * @param stream
	 * @param {} incomingHeaders
	 * @param options
	 */
	constructor(stream, incomingHeaders, options = {}) {
		super();
		this.#stream = stream;
		this.#incomingHeaders = incomingHeaders;
		this.#server = options.server;
		this.#logger = options.logger;
		this.#session = options.session;
		this.#handshake();
		this.#stream.on('data', this.#dataListener);
		this.#stream.on('end', this.#endListener);
		this.#stream.on('error', this.#errorListener);
	}

	#errorListener = (error) => {
			this.#logger.error(error);
			this.emit('error', error);
			this.#stream.end();
	}

	#endListener = () => {
		this.emit('end');
		this.#stream.end();
	}
	#dataListener = (fragment) => {
		// Buffer the chunk for parsing in case of a larger websocket frame.
		const parsedFragment = WsH2Stream.#fragmentInterpreter(fragment);
		this.#currentFrameFragments.push(parsedFragment);
		this.#parseFrame();
	}

	#handshake(){
		const responseHeaders = {
			[http2.constants.HTTP2_HEADER_STATUS]: http2.constants.HTTP_STATUS_OK,
		};
		if(this.#incomingHeaders[http2.constants.HTTP2_HEADER_WS_PROTO]){
			this.#requestedWsProtocols = this.#incomingHeaders[http2.constants.HTTP2_HEADER_WS_PROTO].split(",");
		}
		const matchedProtocols = this.#requestedWsProtocols?.filter(
				protocol => WsH2Stream.#acceptedProtocols.includes(protocol)
		);
		if(matchedProtocols?.length) {
			responseHeaders[http2.constants.HTTP2_HEADER_WS_PROTO] = matchedProtocols.join(",");
		}
		this.#stream.respond(responseHeaders);
	}

	get logger(){
		return this.#logger;
	}

}
