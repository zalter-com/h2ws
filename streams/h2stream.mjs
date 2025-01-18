import http2 from "node:http2";
import {EventEmitter} from "node:events";
import {WsH2Stream} from "./ws-h2stream.mjs";

// http2.constants.HTTP2_HEADER_PROTOCOL = ":protocol";

export class H2Stream extends EventEmitter {
	#stream = null;
	#incomingHeaders = {};
	#logger = console;
	#server = null;
	#session = null;
	#sentHeaders = null;
	#dataDonePromise = null;
	#closed = false;
	#errorProtocol = "logger";


	static categorise(stream, incomingHeaders, options = {}) {
		if (incomingHeaders[http2.constants.HTTP2_HEADER_METHOD] === "CONNECT") {
			switch (incomingHeaders[http2.constants.HTTP2_HEADER_PROTOCOL]) {
				case "websocket":
					return new WsH2Stream(stream, incomingHeaders, options);
				case "webtransport":
					// No idea what to check here and how to start dealing with this one, but we'll get to it.
					(options.logger || console).error("WebTransport not implemented.");
					stream.respond({
						[http2.constants.HTTP2_HEADER_STATUS]: http2.constants.HTTP_STATUS_NOT_IMPLEMENTED
					}, {endStream: true});
					stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
					return;
				default:
					stream.respond({
						[http2.constants.HTTP2_HEADER_STATUS]: http2.constants.HTTP_STATUS_NOT_IMPLEMENTED
					}, {endStream: true});
					stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
					return;
			}
		}
		return new H2Stream(stream, incomingHeaders, options);
	}

	constructor(stream, incomingHeaders, options = {}) {
		super();
		this.#stream = stream;
		this.#incomingHeaders = incomingHeaders;
		this.#server = options.server;
		this.#logger = options.logger;
		this.#session = options.session;
	}

	respond(headers, responseOptions) {
		if(this.#sentHeaders){
			if(this.#errorProtocol === "throw")
				throw new Error("Headers already sent.");
			this.#logger.error("Headers already sent.");
			return;
		}
		this.#sentHeaders = headers;
		this.#stream.respond(headers, responseOptions?.waitForTrailers ? {waitForTrailers: true} : undefined);
		if(responseOptions?.endStream) {
			this.end();
		}
	}


	get closed(){
		return this.#closed || this.#stream.closed || this.#stream.destroyed;
	}

	get incomingHeaders() {
		return {...this.#incomingHeaders};
	}

	get errorProtocol(){
		return this.#errorProtocol;
	}

	/**
	 * @returns {Object<string, number|string> || boolean}
	 */
	get sentHeaders() {
		return this.#sentHeaders || false;
	}

	sendData(data){
		if(!this.sentHeaders){
			throw new Error("Must respond before sending data");
		}
		this.#stream.write(data)
	}

	end(endStatus){
		this.#closed = true;
		this.#stream.end(endStatus);
	}

}

