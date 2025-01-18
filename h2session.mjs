import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import {H2Stream} from "./streams/h2stream.mjs";
import {WsH2Stream} from "./streams/ws-h2stream.mjs";

export class H2Session extends EventEmitter {
	/**
	 * The HTTP2 session.
	 * @type {ServerHttp2Session}
	 */
	#session = null;
	/**
	 * The server instance.
	 * @type {H2Server}
	 */
	#server = null;
	/**
	 * The logger to use for the session.
	 * @type {Console | console}
	 */
	#logger = console;
	/**
	 * The interval for the ping.
	 * @type {NodeJS.Interval | number | null}
	 */
	#pingInterval = null;
	/**
	 * The latency of the session.
	 * @type {number}
	 */
	#latency = 0;

	/**
	 * The streams of the session.
	 * @type {Map<ServerHttp2Session, H2Session>}
	 */
	#streams = new Map();
	/**
	 * The data of the session.
	 * @type {Object<string, any>}
	 */
	#data = {};

	/**
	 *
	 * @param {ServerHttp2Session} session
	 * @param {Object<string, any>} [options.existingSessionData]
	 * @param {Console?} options.logger
	 * @param {H2Server?} options.server
	 */
	constructor(session, options = {}) {
		super();
		this.#session = session;
		this.#logger = options?.logger || console;
		this.#server = options.server;

		this.#data = options?.existingSessionData || {};
		this.#attachListeners();
	}

	/**
	 * Listener for the stream event. Categorises the stream and emits the stream event.
	 * @param {ServerHttp2Stream} stream
	 * @param {Object<string, any>} headers
	 */
	#streamListener = (stream, headers) => {
		this.#logger.debug("Stream Initiated with headers", headers);
		const h2Stream = H2Stream.categorise(stream, headers, {
			server: this.#server,
			session: this,
			logger: this.#logger
		});
		if(!h2Stream){
			this.#logger.warn("Stream not handled.");
			stream.respond({
				[http2.constants.HTTP2_HEADER_STATUS]: http2.constants.HTTP_STATUS_NOT_IMPLEMENTED
			});
			stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
			return;
		}
		this.#streams.set(stream, h2Stream);
		stream.on('close', () => {
			this.#streams.delete(stream);
		});
		stream.on('error', (err) => {
			this.#logger.error(err);
			this.#streams.delete(stream);
		});
		this.emit('stream', h2Stream);
	}

	/**
	 * Listener for the close event. Only emits the close event further.
	 */
	#closeListener = () => {
		this.emit('close');
	}

	/**
	 * Listener for the error event. Only emits the error event further.
	 */
	#errorListener = (err) => {
		this.emit('error', err);
	}

	/**
	 * Listener for the ping event. Emits the ping event further, and stops the interval if the session is destroyed or closed.
	 * It is used to measure the latency of the session.
	 * @param err
	 * @param latency
	 */
	#pingListener = (err, latency) => {
		if(err){
			this.#logger.error(err);
			return;
		}
		this.#latency = latency;
		this.emit('ping', latency);
		if(this.#session.destroyed || this.#session.closed){
			clearInterval(this.#pingInterval);
			this.#pingInterval = null;
		}
	}

	/**
	 * Attaches the listeners to the session, and starts the ping interval.
	 */
	#attachListeners(){
		this.#session.on('stream', this.#streamListener);
		this.#session.on('close', this.#closeListener);
		this.#session.on('error', this.#errorListener);
		this.#pingInterval = setInterval(() => {
			if(this.#session.destroyed || this.#session.closed){
				clearInterval(this.#pingInterval);
				this.#pingInterval = null;
				return;
			}
			this.#session.ping(this.#pingListener);
		}, 1000);
	}

	/**
	 * Data associated with the session.
	 * @type {Object<string, any>}
	 */
	get data() {
		return this.#data;
	}

	/**
	 * The latency of the session.
	 * @type {number}
	 */
	get latency(){
		return this.#latency;
	}

	/**
	 * The remote IP and port of the session if available in the shape of "IP : PORT".
	 * @type {string}
	 */
	get remoteIpAndPort(){
		return `${this?.#session?.socket?.remoteAddress} : ${this?.#session?.socket?.remotePort}`;
	}
}
