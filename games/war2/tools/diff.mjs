/**
 * Shared unit-diff logic used by debug-server.mjs and mcp-inspector.mjs.
 * Keeps the diffed field list and output shape in one place so adding a new
 * field (e.g. health) only requires one edit.
 */

export const DIFF_FIELDS = ['curTx', 'curTy', 'dir', 'moving', 'pathActive', 'moveActive'];

/**
 * Compare two state blobs (host vs peer) and return an array of per-unit diffs.
 * Each entry is either { uid, issue: string } or { uid, fields: { [field]: { host, peer } } }.
 */
export function computeDiff(hostState, peerState) {
    const diffs = [];
    const peerUnits = new Map((peerState.units ?? []).map(u => [u.uid, u]));

    for (const hu of (hostState.units ?? [])) {
        const pu = peerUnits.get(hu.uid);
        if (!pu) { diffs.push({ uid: hu.uid, issue: 'missing on peer' }); continue; }

        const changed = {};
        for (const f of DIFF_FIELDS) {
            if (hu[f] !== pu[f]) changed[f] = { host: hu[f], peer: pu[f] };
        }
        if (Object.keys(changed).length) diffs.push({ uid: hu.uid, fields: changed });
    }

    return diffs;
}
