import { makeCogniGraph } from "../../runtime/cogni/make-cogni-graph";
import { createCogniGraph } from "./graph";
import { COGNI_TOOL_IDS } from "./tools";
export const cogniGraph = makeCogniGraph({
	name: "cogni",
	createGraph: createCogniGraph,
	toolIds: COGNI_TOOL_IDS,
	program: "cogni",
});
