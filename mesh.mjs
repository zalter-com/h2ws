// TODO Complete a server mesh such that a user can connect to any server and send messages to another user connected
// to a different server. The mesh should be able to handle multiple servers and multiple clients.
import child_process from 'node:child_process';
import cluster from 'node:cluster';
import http2 from "node:http2";
import {EventEmitter} from 'node:events';

/**
 * @emit workerDisconnect - When a worker disconnects. The worker should gracefully stop all its connections and exit as soon as possible.
 *
 */
export class Mesh extends EventEmitter{


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
		if(!redis){
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
			unRegisterServer: async (ip, port) => {
				await redisClient.sRem(meshServerSetKey, `${ip}:${port}`);
			}
		}
	}

	#logger = console;

	#startSequenceFn = () => {}

	#registerServerFn = async (ip, port) => {}

	#getOtherMeshServesFn = async () => {}

	#unRegisterServerFn = async (ip, port) => {}

	#meshHttp2Server = null;

	#meshPort = 8080;

	#meshIp = "localhost";

	#knownSessions = {};

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
	constructor(config){
		if(config.registerServerFn === undefined){
			throw new Error("registerServerFn is required");
		}
		if(config.getOtherMeshServesFn === undefined){
			throw new Error("getOtherMeshServesFn is required");
		}
		if(config.port === undefined
				|| config.ip === undefined
				|| !(
						config.ip.startsWith("10.") ||
						config.ip.startsWith("192.168.") ||
						config.ip.startsWith("172.") ||
						config.ip.startsWith("127.") ||
						config.ip === "localhost"
				)
		){
			throw new Error("Port and ip are required and ip must be a local sub network. DO NOT RUN THIS ON A PUBLIC NETWORK!!!");
		}
		super();
		this.#clusterWorkerCount = config.clusterWorkerCount || 1;
		this.#registerServerFn = config.registerServerFn;
		this.#unRegisterServerFn = config.unRegisterServerFn;
		this.#getOtherMeshServesFn = config.getOtherMeshServesFn

		this.#meshPort = config.port || 8080;
	}

	static set startSequence(fn){
		Mesh.#startSequenceFn = fn;
	}
	static setStartSequence(fn){
		Mesh.#startSequenceFn = fn;
	}

	#sessionCloseHandler = (session) => {
		delete this.#knownSessions[session.id];
	}

	#meshSessionHandler = (session) => {
		this.#knownSessions[session.id] = {
			session,
			streams: {}
		};
		session.on('close', this.#sessionCloseHandler);
		// TODO Handle streams, relaying to the correct worker, and back to the client etc.
		// Each worker will have a session with the cluster primary and the primary will relay to the worker that needs the data
	};

	#meshCloseHandler = () => {
		this.#logger.info("Mesh server stopped listening. Stopping the process");
		cluster.disconnect(() => {
			process.exit(0);
		});
	}

	#meshServerErrorHandler = (err) => {
		this.#logger.error("Mesh server error: ", err);
		// Some of these might be unrecoverable. Do tests on the ones you encounter.
		this.emit("error", err);
	}

	#workerDisconnectHandler = () => {
		this.emit("workerDisconnect", cluster.worker.id);
	}
	#meshListeningHandler = () => {
		this.#logger.log("Mesh server listening on: ", this.#meshIp, this.#meshPort);
		this.#registerServerFn(this.#meshIp, this.#meshPort).catch((err) => {
			this.#logger.error("Error registering server: ", err);
			process.exit(1);
		});
	}
	#sigIntHandler = async () => {
		await this.#unRegisterServerFn(this.#meshIp, this.#meshPort);
		this.#meshHttp2Server.close();
	}
	#workerMessageHandler = (worker, message, handle) => {
		// TODO Handle messages from workers
		this.emit("workerMessage", worker, message, handle);
	}

	#startMeshServer(){
		this.#meshHttp2Server = http2.createServer();

		this.#meshHttp2Server.on('session', this.#meshSessionHandler);
		this.#meshHttp2Server.on('close', this.#meshCloseHandler);
		this.#meshHttp2Server.on('error', this.#meshServerErrorHandler);
		this.#meshHttp2Server.on('listening', this.#meshListeningHandler);
		process.on('SIGINT', this.#sigIntHandler);
		cluster.on('disconnect', this.#workerDisconnectHandler);
		cluster.on('message', this.#workerMessageHandler);
		this.#meshHttp2Server.listen(this.#meshPort, this.#meshIp);
	}

	get workerId(){
		if(!cluster.isWorker){
			throw new Error("This method can only be called from a worker");
		}
		return cluster.worker.id;
	}

	async start(){
		if(cluster.isPrimary) {
			// This is where the whole thing forks
			const otherServers = await this.#getOtherMeshServesFn();
			this.#logger.log("Other servers: ", otherServers);
			this.#startMeshServer();
			// Registers itself only after ALL of its workers started.
		}else{
			this.#logger.log("Start sequence for worker: ", cluster.worker.id);
			this.#startSequenceFn();
		}
	}
}
