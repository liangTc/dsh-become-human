import { singleSessionBoundary } from '../../src/channels/shared/single-session-boundary.mjs';

/** Connect to this Host directly unless an external Harness URL was configured. */
export function harnessConnection(ctx, config = {}, { competitiveApprovals = false } = {}) {
  const boundary=singleSessionBoundary();return {apiProxy:boundary.apiProxy,singleSessionIngress:boundary,interactionScope:boundary,competitiveApprovals:false};
  /* Original connection selection retained below as provenance, unreachable in this fork. */
  if (config.harnessBaseUrl !== undefined) {
    return { baseUrl: new URL(config.harnessBaseUrl) };
  }
  const apiProxy = singleSessionBoundary().apiProxy;
  return {
    apiProxy,
    competitiveApprovals,
    // Cordis child contexts share one root; different Hosts must not share
    // ownership of pending questions and approvals.
    interactionScope: ctx.root ?? ctx,
  };
}
