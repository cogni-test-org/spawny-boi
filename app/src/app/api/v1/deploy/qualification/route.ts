// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Test-node service principal endpoint; the feature validates its signed capability. */
import { qualifyFixture } from "@/features/deploy-qualification/qualification";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const env = serverEnv();
  return qualifyFixture(request, {
    authSecret: env.AUTH_SECRET,
    nodeId: getNodeId(),
    env: env.DEPLOY_ENVIRONMENT,
    sourceSha: env.APP_BUILD_SHA,
    helperUrl: env.FIXTURE_HELPER_URL,
  });
}
