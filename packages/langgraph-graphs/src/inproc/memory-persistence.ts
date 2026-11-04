import { InMemoryStore, MemorySaver } from "@langchain/langgraph";

export async function createMemoryPersistence(store = new InMemoryStore()) {
	return {
		checkpointer: new MemorySaver(),
		store,
		async close() {},
	};
}
