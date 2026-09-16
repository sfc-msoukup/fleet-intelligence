import { fleetQuery, num, numOrNull, str } from "@/lib/fleet-data";
import { Q_TRACE_SPANS } from "@/lib/fleet-sql";

export const dynamic = "force-dynamic";

/**
 * Span tree for a single trace, in isolation.
 *
 * Split out of /api/agent so expanding a trace ribbon fetches ONLY its spans,
 * not the agent's full deep-dive payload. That is what removed the whole-page
 * "reload" feel on the /agents route. traceId is bound, never interpolated.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ traceId: string }> },
) {
  try {
    const { traceId } = await params;
    const id = decodeURIComponent(traceId);
    const spans = await fleetQuery(Q_TRACE_SPANS, [id]);
    return Response.json({
      traceId: id,
      spans: spans.map((r) => ({
        spanId: str(r.SPAN_ID),
        parentSpanId: str(r.PARENT_SPAN_ID),
        spanName: str(r.SPAN_NAME),
        spanCategory: str(r.SPAN_CATEGORY),
        startTs: str(r.START_TS),
        endTs: str(r.END_TS),
        latencyMs: numOrNull(r.LATENCY_MS),
        // Some spans emit start after end; the data layer nulls those. Surfaced
        // as a flag so the waterfall can exclude them visibly rather than
        // drawing a misleading zero-width bar.
        hasInvalidDuration: Boolean(r.HAS_INVALID_DURATION),
        stepNumber: r.STEP_NUMBER === null ? null : num(r.STEP_NUMBER),
        modelName: str(r.MODEL_NAME),
        toolStatus: str(r.TOOL_STATUS),
        toolStatusDescription: str(r.TOOL_STATUS_DESCRIPTION),
        planningStatus: str(r.PLANNING_STATUS),
        isToolError: Boolean(r.IS_TOOL_ERROR),
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[api/trace]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
