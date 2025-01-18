// TODO Complete a server mesh such that a user can connect to any server and send messages to another user connected
// to a different server. The mesh should be able to handle multiple servers and multiple clients.
import child_process from 'node:child_process';
import cluster from 'node:cluster';
import http2 from "node:http2";
import {EventEmitter} from 'node:events';

export class Mesh {
	#startSequenceFn = () => {}
	#registerServerFn = (ip, port) => {}
	#getOtherMeshServesFn = () => {}
	#meshHttp2Server = null;
	#meshPort = 8080;
	#knownSessions = {};

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

	/**
	 * @param {Object} config
	 * @param {function} config.registerServerFn
	 * @param {() => string[]} config.getOtherMeshServesFn
	 * @param {number} config.port
	 * @param {string} config.ip
	 * @param {function} config.startSequenceFn
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
				|| config.ip.startsWith("127.")
				|| config.ip === "localhost"
				|| !(config.ip.startsWith("10.") || config.ip.startsWith("192.168.") || config.ip.startsWith("172.16."))
		){
			throw new Error("Port and ip are required and ip must be a local sub network. DO NOT RUN THIS ON A PUBLIC NETWORK!!!");
		}

		this.#registerServerFn = config.registerServerFn;
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

	#startMeshServer(){
		this.#meshHttp2Server = http2.createServer();

		this.#meshHttp2Server.on('session', (session) => {
			this.#knownSessions[session.id] = {
				session,
				streams: {}
			};
			session.on('close', this.#sessionCloseHandler);
			// Each worker will have a session with the cluster primary and the primary will relay to the worker that needs the data

		})
	}

	start(){
		if(cluster.isPrimary) {
			// This is where the whole thing forks

		}else{
			Mesh.#startSequenceFn();
		}
	}
}
