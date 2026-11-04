import { makeServerGraph } from "../../runtime/core/make-server-graph";
import { createCogniGraph } from "./graph";
import { COGNI_TOOL_IDS } from "./tools";
export const cogni = await makeServerGraph({
	name: "cogni",
	createGraph: createCogniGraph,
	toolIds: COGNI_TOOL_IDS,
	program: "cogni",
});
