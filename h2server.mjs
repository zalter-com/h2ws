import {EventEmitter} from "node:events";
import http2 from "node:http2";
import {H2Session} from "./h2session.mjs";


/**
 * The HTTP/2 server. The actual Node.js HTTP/2 server is wrapped in this class.
 * @emit H2Server#listening
 * @emit H2Server#secureConnection
 * @emit H2Server#tlsClientError
 * @emit H2Server#connection
 * @emit H2Server#session
 * @emit H2Server#close
 * @emit H2Server#error
 * @emit H2Server#sessionError
 * @emit H2Server#stream
 * @extends EventEmitter
 */
export class H2Server extends EventEmitter {
	/**
	 * The default size for the HTTP/2 frame.
	 * @type {number}
	 */
	static H2_16k = 16 * 1024;
	/**
	 * The server instance.
	 * @type {Http2SecureServer}
	 */
	#serverInstance = null;
	/**
	 * The port the server is listening on.
	 * @type {number}
	 */
	#port = 8443;
	/**
	 * The address the server is listening on.
	 * @type {string}
	 */
	#listeningAddress = "0.0.0.0";
	/**
	 * The logger to use for the server.
	 * @type {Console | console}
	 */
	#logger = console;

	#isListening = false;

	/**
	 * A map containing the known sessions. It has the session as key and the H2Session as value.
	 * @type {Map<ServerHttp2Session, H2Session>}
	 */
	#knownSessions = new Map();

	/**
	 * Constructs an HTTP2 server and adds all event listeners.
	 * @param {Console?} options.logger
	 * @param {number?} options.port
	 * @param {string?} options.listeningAddress
	 * @param {function?} optinos.SNICallback
	 * @param {Object<string, any>} options.ssl SSL Options
	 * @param {string} options.ssl.key SSL Key
	 * @param {string} options.ssl.cert SSL Certificate
	 */
	constructor(options) {
		super();
		this.#logger = options.logger || console;
		this.#port = options.port || 8443;
		this.#listeningAddress = options.listeningAddress || "0.0.0.0";

		this.#serverInstance = http2.createSecureServer({
			key: options.ssl.key,
			cert: options.ssl.cert,
			secureOptions: (
					http2.constants.SSL_OP_NO_TLSv1 |
					http2.constants.SSL_OP_NO_SSLv3 |
					http2.constants.SSL_OP_NO_SSLv2 |
					http2.constants.SSL_OP_NO_TLSv1_1
			),
			SNICallback: options.SNICallback || undefined,
			// allowHTTP1: options.allowHTTP1 || false,
			settings: {
				enableConnectProtocol: true,
				customSettings: {
					0x2b60: 100,
					0x2b61: H2Server.H2_16k,
					0x2b62: H2Server.H2_16k,
					0x2b63: H2Server.H2_16k,
					0x2b64: 100,
					0x2b65: 100
				},
				remoteCustomSettings: [0x2b60, 0x2b61, 0x2b62, 0x2b63, 0x2b64, 0x2b65]
			}
		});
		this.#attachListeners();
	}


	/**************************************************************************
	 * <Listeners>
	 *************************************************************************/

	/**
	 * Listener for when the server starts listening. It sets the listening address and port. Emits the listening event.
	 * @emits H2Server#listening
	 */
	#startedListeningListener = () => {
		this.#isListening = true;
		const address = this.#serverInstance.address();
		this.#listeningAddress = address.address;
		this.#port = address.port;
		this.#logger.info(`HTTP/2 Listening on ${this.#listeningAddress}:${this.#port}`);
		this.emit("listening", this.#listeningAddress, this.#port);
	};

	/**
	 * Listener for when a secure connection is initiated.
	 * @emits H2Server#secureConnection
	 * @param {Socket} socket
	 * @emits H2Server#secureConnection
	 */
	#secureConnectionListener = (socket) => {
		this.#logger.info(`secure connection initiated with ip: ${socket?.remoteAddress}`);
		this.emit("secureConnection", socket);
	};

	/**
	 * Listener for when a TLS client error occurs.
	 * @emits H2Server#tlsClientError
	 * @param {Error} err The error that occurred.
	 * @param {Socket} socket The socket that caused the error.
	 * @emits H2Server#tlsClientError
	 */
	#tlsClientErrorListener = (err, socket) => {
		this.#logger.error(`tlsClientError ip: ${socket?.remoteAddress}`, err);
		this.emit("tlsClientError", err, socket);
	};

	/**
	 * Listener for when a connection is initiated.
	 * @param {Socket} socket The socket that initiated the connection.
	 * @emits H2Server#connection
	 */
	#connectionListener = (socket) => {
		this.#logger.debug(`connection initiated ip: ${socket?.remoteAddress}`);
		this.emit("connection", socket);
	};

	/**
	 * Listener for when a session is initiated.
	 * @param session
	 * @emits H2Server#session
	 * @emits H2Server#stream
	 */
	#sessionListener = (session) => {
		const h2Session = new H2Session(session, {
			logger: this.#logger,
			server: this
		});
		h2Session.on("close", () => {
			this.#logger.debug(`session closed for: ${h2Session.remoteIpAndPort}`);
			this.#knownSessions.delete(session);
		});
		this.#knownSessions.set(session, h2Session);
		this.emit("session", h2Session);

		h2Session.on("stream", (h2Stream) => {
			this.emit("stream", h2Stream);
		});
	};

	/**
	 * Listener for the close event. Only emits the close event further.
	 * @emits H2Server#close
	 */
	#closeListener = () => {
		this.#logger.info("server closed");
		this.emit("close");
	};

	/**
	 * Listener for the error event. Only emits the error event further.
	 * @param {Error} err The error that occurred.
	 * @emits H2Server#error
	 */
	#errorListener = (err) => {
		this.#logger.error("server error", err);
		this.emit("error", err);
	};

	/**
	 * Listener for when a session error occurs.
	 * @param err
	 * @param {ServerHttp2Session} session The session that caused the error.
	 * @emits H2Server#sessionError
	 */
	#sessionErrorListener = (err, session) => {
		this.#logger.error("session error", err);
		const h2Session = this.#knownSessions.get(session);
		this.emit("sessionError", err, h2Session);
		this.#knownSessions.delete(session);
	};

	/**
	 * Attaches the listeners to the server instance.
	 */
	#attachListeners() {
		this.#serverInstance.on("secureConnection", this.#secureConnectionListener);
		this.#serverInstance.on("listening", this.#startedListeningListener);
		this.#serverInstance.on("tlsClientError", this.#tlsClientErrorListener);
		this.#serverInstance.on("connection", this.#connectionListener);
		this.#serverInstance.on("session", this.#sessionListener);
		this.#serverInstance.on("close", this.#closeListener);
		this.#serverInstance.on("error", this.#errorListener);
		this.#serverInstance.on("sessionError", this.#sessionErrorListener);
	}

	/**************************************************************************
	 * Public Methods
	 *************************************************************************/

	/**
	 * Is the server listening currently?
	 * @returns {boolean}
	 */
	get isListening() {
		return this.#isListening;
	}

	/**
	 * Starts the server listening on the specified port and address.
	 */
	listen() {
		this.#serverInstance.listen(this.#port || 8443, this.#listeningAddress || "0.0.0.0");
	}

}
