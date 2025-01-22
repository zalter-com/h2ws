// TODO Complete a server mesh such that a user can connect to any server and send messages to another user connected
// to a different server. The mesh should be able to handle multiple servers and multiple clients.
import child_process from "node:child_process";
import cluster from "node:cluster";
import http2 from "node:http2";
import {EventEmitter} from "node:events";
import {cpus} from "node:os";
import {Decoder, Encoder} from "cbor";
const localhostVariants = ["localhost", "127.0.0.1", "::1"];

/**
 * @emit workerDisconnect - When a worker disconnects. The worker should gracefully stop all its connections and exit as soon as possible.
 *
 */
export class Mesh extends EventEmitter {
	/**
	 * @param {Object} config
	 * @param {string ?} config.redisHost default localhost
	 * @param {number ?} config.redisPort default 6379
	 * @param {string ?} config.redisPass	default ""
	 * @param {number ?} config.redisDb	default 0
	 * @param {string ?} config.meshServerSetKey default "mesh_servers"
	 * @returns {
	 * 		Promise<
	 * 			{
	 * 				getOtherMeshServes: (function(): Promise<String[]>>),
	 * 				registerServer: ((function(*, *): Promise<void>)|*),
	 * 				unRegisterServer: ((function(*, *): Promise<void>)|*)
	 * 			}
	 * 		>
	 * 		}
	 */
	static redisServerRegistrationStrategy = async (config) => {
		const redis = await import("redis"); // if it throws then redis is not installed
		if (!redis) {
			throw new Error("Redis is not installed. Please install redis node module or create a custom registration strategy");
		}

		const redisPass = config.redisPass || "";
		const redisPort = config.redisPort || 6379;
		const redisHost = config.redisHost || "localhost";
		const redisDb = config.redisDb || 0;
		const redisClient = redis.createClient({
			port: redisPort,
			host: redisHost,
			password: redisPass,
			db: redisDb
		});
		const meshServerSetKey = config.meshServerSetKey || "mesh_servers";
		await redisClient.connect();
		return {
			registerServer: async (ip, port) => {
				await redisClient.sAdd(meshServerSetKey, `${ip}:${port}`);
			},
			getOtherMeshServes: async () => {
				return await redisClient.sMembers(meshServerSetKey);
			},
			unRegisterServer: async (ipPortOrIp, port) => {
				if(port === undefined){
					await redisClient.sRem(meshServerSetKey, ipPortOrIp);
					return;
				}
				await redisClient.sRem(meshServerSetKey, `${ipPortOrIp}:${port}`);
			}
		};
	};
	static MESH_IP_HEADER = "mesh-ip";
	static MESH_PORT_HEADER = "mesh-port";

	#logger = console;

	#startSequenceFn = () => {
	};

	#registerServerFn = async (ip, port) => {
	};

	#getOtherMeshServesFn = async () => {
	};

	#unRegisterServerFn = async (ip, port) => {
	};

	#meshHttp2Server = null;

	#meshPort = 8080;

	#meshIp = "localhost";

	#knownServerConnections = {
		bySession: {},
		byIPAndPort: {}
	};

	#clusterWorkerCount = 1;


	/**
	 * @param {Object} config
	 * @param {() => Promise<*|void>} config.registerServerFn
	 * @param {() => Promise<*|void>} config.unRegisterServerFn
	 * @param {() => Promise<string[]>} config.getOtherMeshServesFn
	 * @param {number} config.port
	 * @param {string} config.ip
	 * @param {function} config.startSequenceFn
	 * @param {number} config.clusterWorkerCount
	 *
	 */
	constructor(config) {
		if (config.registerServerFn === undefined) {
			throw new Error("registerServerFn is required");
		}
		if (config.getOtherMeshServesFn === undefined) {
			throw new Error("getOtherMeshServesFn is required");
		}
		if (config.port === undefined
				|| config.ip === undefined
				|| !(
						config.ip.startsWith("10.") ||
						config.ip.startsWith("192.168.") ||
						config.ip.startsWith("172.") ||
						config.ip.startsWith("127.") ||
						config.ip === "localhost"
				)
		) {
			throw new Error("Port and ip are required and ip must be a local sub network. DO NOT RUN THIS ON A PUBLIC NETWORK!!!");
		}
		super();
		this.#clusterWorkerCount = config.clusterWorkerCount || 1;
		this.#registerServerFn = config.registerServerFn;
		this.#unRegisterServerFn = config.unRegisterServerFn;
		this.#getOtherMeshServesFn = config.getOtherMeshServesFn;

		this.#meshPort = config.port || 8080;
	}

	static set startSequence(fn) {
		Mesh.#startSequenceFn = fn;
	}

	static setStartSequence(fn) {
		Mesh.#startSequenceFn = fn;
	}

	#sessionCloseHandler = (session) => {
		// Remove all streams associated with the session. There should only be one with that particular mesh server.
		// Should be able to identify the remote ip from the session.socket.remoteAddress albeit the remote metal might have multiple servers running on the same ip.
		// and on different ports. Port has to be declared as part of the stream initiation.
	};

	#meshSessionHandler = (session) => {
		this.#knownServerConnections.bySession[session.id] = {
			session,
			streams: {}
		};
		session.on("stream", this.#meshStreamHandler);
		session.on("close", this.#sessionCloseHandler);
		// TODO Handle streams, relaying to the correct worker, and back to the client etc.
		// Each worker will have a session with the cluster primary and the primary will relay to the worker that needs the data
	};

	#meshStreamHandler = (stream, headers) => {
		const remoteIpHeader = headers[Mesh.MESH_IP_HEADER];
		const remotePortHeader = headers[Mesh.MESH_PORT_HEADER];
		const remoteSocketAddress = stream.session.socket.remoteAddress;
		if (remoteIpHeader === undefined || remotePortHeader === undefined) {
			stream.respond({
				[http2.constants.HTTP2_HEADER_STATUS]: 400
			}, {endStream: true});
			this.#logger.error("Missing required headers: ", stream.headers);
			return;
		}

		if (remoteIpHeader !== remoteSocketAddress && !(localhostVariants.includes(remoteIpHeader) && localhostVariants.includes(remoteSocketAddress))) {
			stream.respond({
				[http2.constants.HTTP2_HEADER_STATUS]: 400
			}, {endStream: true});
			this.#logger.error("Invalid remote ip: ", remoteSocketAddress, " !== ", remoteIpHeader);
			return;
		}
		const remoteIpAndPort = `${remoteIpHeader}:${remotePortHeader}`; // In theory this should be unique
		if (this.#knownServerConnections.byIPAndPort[remoteIpAndPort] !== undefined) {
			stream.respond({
				[http2.constants.HTTP2_HEADER_STATUS]: 404
			}, {endStream: true});
			this.#logger.error("Existing server connection: ", remoteIpAndPort);
			return;
		}
		// Saved for availability once the stream is destroyed or closed.
		const sessionId = stream.session.sessionId;
		const streamId = stream.id;

		this.#knownServerConnections.bySession[sessionId].streams[streamId] = stream; // yet again should only ever have one single stream.
		this.#knownServerConnections.byIPAndPort[remoteIpAndPort] = stream;
		this.#logger.info("New inbound mesh server connection: ", remoteIpAndPort);
		this.#processMeshStreamData(stream, remoteIpAndPort);
		stream.respond({
			[http2.constants.HTTP2_HEADER_STATUS]: 200
		});
	};

	#processMeshStreamData = (stream, remoteIpAndPort, isOut = false) => {
		this.#logger.debug("Processing mesh server stream data: ", remoteIpAndPort);
		const sessionId = stream.session.sessionId;
		const streamId = stream.id;
		stream.on("close", () => {
			this.#logger.info("Mesh server connection closed: ", remoteIpAndPort);
			delete this.#knownServerConnections.bySession?.[sessionId]?.streams?.[streamId];
			delete this.#knownServerConnections.byIPAndPort?.[remoteIpAndPort];
		});
		stream.on("data", (data) => {
			// Incoming data from the mesh server. Have to relay it to the correct worker.
			// Decode the message and execute the appropriate action or forward to the correct worker.
		});
		stream.on("end", () => {
			// Incoming data stream ended. Have to close the other end since this one is in fact full duplex.
			this.#logger.debug("Incoming mesh server stream ended: ", remoteIpAndPort, `on an ${isOut ? "outbound" : "inbound"} stream`);
			stream.end();
		})
	};

	#meshCloseHandler = () => {
		this.#logger.info("Mesh server stopped listening. Stopping the process");
		cluster.disconnect(() => {
			process.exit(0);
		});
	};

	#meshServerErrorHandler = (err) => {
		this.#logger.error("Mesh server error: ", err);
		// Some of these might be unrecoverable. Do tests on the ones you encounter.
		this.emit("error", err);
	};

	#workerDisconnectHandler = () => {
		this.emit("workerDisconnect", cluster.worker.id);
	};

	#meshListeningHandler = () => {
		this.#logger.log("Mesh server listening on: ", this.#meshIp, this.#meshPort);
		this.#registerServerFn(this.#meshIp, this.#meshPort).catch((err) => {
			this.#logger.error("Error registering server: ", err);
			process.exit(1);
		});
	};

	#closeAllConnections = async () => {
		for (const ipAndPort in this.#knownServerConnections.byIPAndPort) {
			const stream = this.#knownServerConnections.byIPAndPort[ipAndPort];
			stream.end();
			stream.close();
		}
		for(const sessionId in this.#knownServerConnections.bySession){
			const session = this.#knownServerConnections.bySession[sessionId].session;
			session.close();
		}
	};

	#sigIntHandler = async () => {
		this.#logger.log("SIGINT received. Stopping mesh server");
		await this.#unRegisterServerFn(this.#meshIp, this.#meshPort);
		cluster.disconnect();// should notify all workers to stop... whatever they do with that information.
		this.#meshHttp2Server.close();
		await this.#closeAllConnections();
		this.#logger.log("Mesh server stopped. Stopping the process in 10 seconds");
		setTimeout(() => {
			process.exit(0);
		}, 10000);
	};

	#workerMessageHandler = (worker, message, handle) => {
		// TODO Handle messages from workers -
		//  These should be the ones where the worker wants to send a message to another worker residing on a different server.
		//  The message should be relayed to the correct server and then to the correct worker.
		// this.emit("workerMessage", worker, message, handle);
	};

	#startMeshServer() {
		this.#meshHttp2Server = http2.createServer();

		this.#meshHttp2Server.on("session", this.#meshSessionHandler);
		this.#meshHttp2Server.on("close", this.#meshCloseHandler);
		this.#meshHttp2Server.on("error", this.#meshServerErrorHandler);
		this.#meshHttp2Server.on("listening", this.#meshListeningHandler);
		process.on("SIGINT", this.#sigIntHandler);
		cluster.on("disconnect", this.#workerDisconnectHandler);
		cluster.on("message", this.#workerMessageHandler);

		// First of all connect to the other mesh servers in the swarm. Keep the sessions and their streams in the OutboundSessions.
		this.#meshHttp2Server.listen(this.#meshPort, this.#meshIp);
	}

	#connectToMeshServers = async (otherMeshServers) => {
		this.#logger.debug("Other mesh servers: ", otherMeshServers);
		// Connect to the other servers
		for (
				const serverIpAndPort1 of
				otherMeshServers
					.filter((serverIpAndPort) => serverIpAndPort !== `${this.#meshIp}:${this.#meshPort}`) // filter itself out.
					.map((serverIpAndPort) => (this.#logger.log(serverIpAndPort), serverIpAndPort))
				) {
					this.#logger.debug("Connecting to mesh server: ", serverIpAndPort1);
					try {
						const session = http2.connect(`http://${serverIpAndPort1}`);
						session.on("close", () => {
							this.#logger.log("Mesh Session closed: ", serverIpAndPort1);
							// TODO Reconnect to the server ?
						});
						session.on("error", async (err) => {
							// TODO Check what exactly are the possible errors and how to handle them.
							this.#logger.error("Error connecting to mesh server: ", serverIpAndPort1, err);
							this.#logger.debug("Unregistering unreachable mesh server: ", serverIpAndPort1);
							await this.#unRegisterServerFn(serverIpAndPort1);
						})
						const outboundStream = session.request({
							[Mesh.MESH_IP_HEADER]: this.#meshIp,
							[Mesh.MESH_PORT_HEADER]: this.#meshPort,
							[http2.constants.HTTP2_HEADER_METHOD]: "POST"
						});

						outboundStream.on("error", (err) => {
							this.#logger.error("Outbound mesh stream error: ", serverIpAndPort1, err);
							// TODO Check what exactly are the possible errors and how to handle them.
						})

						outboundStream.on("response", (headers) => {
							this.#logger.debug(`Outbound mesh stream connected to: ${serverIpAndPort1} ... responded with: `, headers);
							this.#processMeshStreamData(outboundStream, serverIpAndPort1, true);
							this.#logger.debug("Sending ping to: ", serverIpAndPort1);
							outboundStream.write("ping");
						})
						outboundStream.on("close", () => {
							// Remove the stream from the outbound sessions
							this.#logger.log("Outbound mesh stream closed: ", serverIpAndPort1);
							// TODO Reconnect to the server ?
						});


					}catch (e) {
						this.#logger.error("Error connecting to mesh server: ", serverIpAndPort1, e);
						this.#logger.debug("Unregistering unreachable mesh server: ", serverIpAndPort1);
						await this.#unRegisterServerFn(serverIpAndPort1);
					}
				}
	};

	get workerId() {
		if (!cluster.isWorker) {
			throw new Error("This method can only be called from a worker");
		}
		return cluster.worker.id;
	}

	async start() {
		if (cluster.isPrimary) {
			// This is where the whole thing forks
			const otherServers = await this.#getOtherMeshServesFn();
			this.#logger.log("Other servers: ", otherServers);
			await this.#connectToMeshServers(otherServers);
			this.#startMeshServer();
			// Registers itself only after ALL of its workers started.
		} else {
			this.#logger.info("Start sequence for worker: ", cluster.worker.id);
			cluster.worker.on('message', (msg) => {
				this.#logger.debug(`Worker ${cluster.worker.id} message: `, msg);
				this.emit("workerMessage", msg); // if they want the worker id they can get it from this.workerId.
			})
			cluster.worker.on('disconnect', () => {
				this.#logger.info("Worker disconnected: ", cluster.worker.id);
				this.emit("workerDisconnect", cluster.worker.id);// Such that the user can close their own server connections.
			});
			this.#startSequenceFn();
		}
	}

	sendToWorker(workerId, message){
		cluster.workers[workerId].send(message);
	}

	sendToAllWorkers(message){
		for(const workerId in cluster.workers){
			cluster.workers[workerId].send(message);
		}
	}
}
