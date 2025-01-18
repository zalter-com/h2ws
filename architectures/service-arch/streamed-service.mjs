import {EventEmitter} from "node:events";

/**
 * StreamedService is a service that can be used to process full duplex streams and websockets.
 * Will include support to pair up half duplex streams to mimic full duplex streams.
 * It has a simple protocol based on CBOR to communicate subcommands and data between the two sides.
 * Each incoming stream will create its own instance of the StreamedService subclass.
 * @note Please note that this is meant to only be extended and not used directly.
 * @abstract
 * When extended, the constructor of the extended class should only accept a transport instance.
 * Your constructor should call super() with the configs and transport.
 * Sub-protocols will include JSON or CBOR. If further sub protocols should be added, they are to be used by overriding the corresponding message translator.
 *
 */
export class StreamedService extends EventEmitter {
	static #ErrorSymbol = Symbol();
	static #NotFoundSymbol = Symbol();
	static get ErrorSymbol(){
		return StreamedService.#ErrorSymbol;
	}
	static get NotFoundSymbol(){
		return StreamedService.#NotFoundSymbol;
	}
	#logger = console;
	#transport = null;

	static actionStrategy = async () => {
		const CBOR = await import("cbor"); // if it fails, it will throw an error... Should only fail if the strategy is called...
		return ((transport, service) => ({
			cbor(obj) {
				return CBOR.encodeOne(obj);
			},
			get CBOR(){
				return CBOR;
			},
			attachEvents(transport, service) {
				transport.on("text", (text) => {
					try {
						const m = JSON.parse(text);
						if (m.action && service[m.action]) {
							service[m.action](m); // probably
						}else if(service[StreamedService.NotFoundSymbol]){
							service[StreamedService.NotFoundSymbol](m);
						}else{
							throw new Error("Action not found");
						}
					}catch(e){
						service[StreamedService.ErrorSymbol](e);
					}
				});
				transport.on("binary", (binaryData) => {
					try {
						const extended = CBOR.decodeFirstSync(binaryData, {extendedResults: true});
						let m = extended.value;
						if (m?.action && service[m.action]) {
							service[m.action](m, extended.unused); // May need the unused part for some reason like signed messages.
						}else if(service[StreamedService.NotFoundSymbol]){
							service[StreamedService.NotFoundSymbol](m);
						}else{
							throw new Error("Action not found");
						}
					}catch(e){
						service[StreamedService.ErrorSymbol](e);
					}
				});
			}
		}));
	};

	/**
	 * The constructor of the StreamedService class.
	 * @param {Object} configs - The configuration object for the service.
	 * @param {H2Stream | WsH2Stream} transport - The transport object that the service will use to communicate with the other side.
	 */
	constructor(configs, transport) {
		super();
		this.#logger = configs.logger || console;
		this.#transport = transport;
		this.attachEvents();
		this.emit("connected");
	}

	/**
	 * The method that will be called to start the service.
	 * @abstract
	 */
	attachEvents() {
		this.#transport.on("close", () => {
			this.emit("close");
		});
		this.#transport.on("error", (error) => {
			this.emit("error", error);
		});
	}

	sendText(text) {
		this.#transport.sendText(text);
	}

	sendBinary(binaryData) {
		this.#transport.sendBinary(binaryData);
	}


}
