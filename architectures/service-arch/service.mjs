import http2 from 'node:http2';
import {WsH2Stream} from "../../streams/ws-h2stream.mjs";

/**
 * The service class is a class that can handle incoming HTTP/2 streams.
 * It acts more or less like a collection of handlers / middlewares that can process a stream that fits a certain set of criteria.
 * It can be nested and using the preHandlers and postHandlers it can be extended with additional functionality.
 * When extended, the user can override some of the default functionality and add some of their own.
 * All headers are treated equally and can be used with a full match to identify the handler that should be used
 * TODO: Add a way to use partial matching to identify the handler that should be used and allow nesting to further identify the handler based on the remaining parts not used
 *       for the previously identified handler.
 */
export class Service{

	/*******************************************************************************************************************
	 * Static properties
	 ******************************************************************************************************************/

	/**
	 * The symbol that is used to identify the not found handler
	 * @type {symbol}
	 */
	static #NotfoundSymbol = Symbol();

	/**
	 * The symbol that is used to identify the error handler
	 * @type {symbol}
	 */
	static #ErrorSymbol = Symbol();

	/**
	 * The symbol that is used to identify the default handler
	 * @type {symbol}
	 */
	static #DefaultSymbol = Symbol();

	/**
	 * The symbol that is used to identify the ignore header handler
	 * @type {symbol}
	 */
	static #IgnoreHeaderSymbol = Symbol();

	/**
	 * The symbol that is used to identify the default handler
	 * @returns {symbol}
	 */
	static get NotFoundSymbol(){
		return Service.#NotfoundSymbol;
	}

	/**
	 * The symbol that is used to identify the error handler
	 * @returns {symbol}
	 */
	static get ErrorSymbol(){
		return Service.#ErrorSymbol;
	}

	/**
	 * The symbol that is used to identify the default handler
	 * @returns {symbol}
	 */
	static get DefaultSymbol(){
		return Service.#DefaultSymbol;
	}

	/**
	 * The symbol that is used to identify the ignore header handler
	 * @returns {symbol}
	 */
	static get IgnoreHeaderSymbol(){
		return Service.#IgnoreHeaderSymbol;
	}


	/*******************************************************************************************************************
	 * Instance properties
	 ******************************************************************************************************************/

	/**
	 * The identifier of the service
	 * @type {symbol}
	 * @default Service.#NotfoundSymbol
	 */
	#identifier = Service.#NotfoundSymbol;

	/**
	 * The header that is used to identify the handler
	 * @type {string}
	 * @default http2.constants.HTTP2_HEADER_METHOD
	 */
	#header = http2.constants.HTTP2_HEADER_METHOD;

	/**
	 * The logger that is used to log messages
	 * @type {Console | console}
	 */
	#logger = console;

	/**
	 * The sub services that are used to identify	the handler
	 * @type {{}}
	 * @note SHOULD be used only for nesting sub services and is meant to be overridden in subclasses.
	 */
	#subServices = {}

	/**
	 * The pre handlers that are used to handle the incoming transport before the actual handler is called. All promises returned will be waited for before it continues to the next one.
	 * IF parallel execution is needed, use Promise.all.
	 * @type {[]}
	 */
	#preHandlers = [];
	/**
	 * The post handlers that are used to handle the incoming transport after the actual handler is called.
	 * All promises returned will be waited for before it continues to the next one.
	 * Intended for use with cleanup, logging, notFound handling, etc.
	 * @type {[]}
	 */
	#postHandlers = [];

	/**
	 * Creates a new service.
	 * @param config
	 */
	constructor(config){
		this.#identifier = config.identifier || Service.#NotfoundSymbol;
		this.#header = config.header || http2.constants.HTTP2_HEADER_METHOD;
		this.#preHandlers = config.preHandlers || [];
		this.#postHandlers = config.postHandlers || [];
		this.#logger = config.logger || console;
	}

	/**
	 * The logger that is used to log messages
	 * @returns {Console|console}
	 */
	get logger() {
		return this.#logger;
	}

	/**
	 * The Identifier of the service. Intended to be used when adding it as a subService to another service.
	 * @returns {symbol}
	 */
	get identifier(){
		return this.#identifier;
	}

	/**
	 * The list of preHandlers that are used to handle the incoming transport before the actual handler is
	 * @returns {function[]}
	 */
	get preHandlers(){
		return [...this.#preHandlers];
	}

	/**
	 * The list of postHandlers that are used to handle the incoming transport after the actual handler is
	 * @returns {function[]}
	 */
	get postHandlers(){
		return [...this.#postHandlers];
	}

	/**
	 * The list of sub services in cases where nesting is necessary.
	 * @returns {{}}
	 */
	get subServices(){
		return {...this.#subServices};
	}

	/**
	 * Starts handling the incoming transport or passes it to a subService.
	 * The transport is passed through the preHandlers, the actual handler and the postHandlers
	 * @param transport
	 */
	async handle(transport){
		this.#logger.debug("Handling transport ...");
		// first check what kind of transport it is
		if(transport instanceof WsH2Stream){
			// This should never reach this point. ALL websocket transports should have been handled prior to being passed to a service handler.
			// This is because websocket connections CAN NOT have any other header than the :path header.
			// Therefore, they can not be identified by other header and hence can not be in a service which is deeper than the default service.
			// To make things easier, the websocket transports should be handled PRIOR to being passed to a service handler.
			this.#logger.error("Websocket transport should have been handled before being passed to a service handler.");
			return;
		}
		if(!this[Service.#ErrorSymbol]){
			this.#logger.error("No error handler set.");
		}
		let identifiedHandler;
		let requestedHandler = transport.incomingHeaders[this.#header];
		if(requestedHandler.startsWith("#")){
			// if the header is a hash, then it is going to default be not found.
			requestedHandler = this[Service.#NotfoundSymbol];
		}
		if(!requestedHandler) {
			// if the header is not set, or the header is the IgnoreHeaderSymbol and thus can not be set then use the default handler
			// if the default handler is not set, use the not found handler
			// if the not found handler is not set, log an error
			identifiedHandler = this[Service.#DefaultSymbol] || this.#subServices[Service.#NotfoundSymbol] || this[Service.#NotfoundSymbol];
		}else{
			identifiedHandler = this.#subServices[requestedHandler] || this[requestedHandler] || this[Service.#NotfoundSymbol];
		}
		if(!identifiedHandler){
			console.warn("Incoming transport could not handled ... Maybe add a default (not found) handler.");
			transport.respond({
				[http2.constants.HTTP2_HEADER_STATUS]: http2.constants.HTTP_STATUS_NOT_IMPLEMENTED
			}, {endStream: true});
			transport.close(http2.constants.NGHTTP2_REFUSED_STREAM);
			return;
		}
		const preHandlers = this.preHandlers;
		const postHandlers = this.postHandlers;
		// Execute pre-handlers
		try {
			for (const handler of preHandlers) {
				await handler(transport);
			}
			// Execute
			if (identifiedHandler instanceof Service) {
				await identifiedHandler.handle(transport);
			} else {
				await identifiedHandler.call(this, transport);
			}

			// Execute post-handlers
			for (const handler of postHandlers) {
				await handler.call(this, transport);
			}
		}catch(e){
			if(this[Service.#ErrorSymbol])
				await this[Service.#ErrorSymbol](transport, e);
			else
				this.#logger.error("Error occurred while handling the transport", e);
		}
	}
}
