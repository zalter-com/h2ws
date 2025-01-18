import {StreamedService} from "../../../architectures/service-arch/streamed-service.mjs";

export class ChatService extends StreamedService{
	#configs = {
		logger: console
	}
	static set configs(value){
		for(const key in this.#configs){
			if(value[key]){
				this.#configs[key] = value[key];
			}
		}
	}
	constructor(transport){
		if(!(transport instanceof WsH2Stream)){
			throw new Error("ChatService can only be used with WsH2Stream");
		}
		super({}, transport);
	}



	attachEvents() {
		super.attachEvents();

	}
}
