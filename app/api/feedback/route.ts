import { fleetQuery, num, str, arr } from "@/lib/fleet-data";
import {
  Q_FEEDBACK_SUMMARY,
  Q_FEEDBACK_CATEGORIES,
  Q_FEEDBACK_UNCATEGORIZED,
  Q_FEEDBACK_ITEMS,
  Q_FEEDBACK_BY_AGENT,
} from "@/lib/fleet-sql";

export const dynamic = "force-dynamic";

/** Page 4 payload: fleet-wide feedback. */
export async function GET() {
  try {
    const [summary, categories, uncategorized, items, byAgent] = await Promise.all([
      fleetQuery(Q_FEEDBACK_SUMMARY),
      fleetQuery(Q_FEEDBACK_CATEGORIES),
      fleetQuery(Q_FEEDBACK_UNCATEGORIZED),
      fleetQuery(Q_FEEDBACK_ITEMS),
      fleetQuery(Q_FEEDBACK_BY_AGENT),
    ]);

    const s = summary[0] ?? {};

    return Response.json({
      summary: {
        total: num(s.TOTAL),
        positive: num(s.POSITIVE),
        negative: num(s.NEGATIVE),
        agents: num(s.AGENTS),
        users: num(s.USERS),
        firstTs: str(s.FIRST_TS),
        lastTs: str(s.LAST_TS),
      },
      // Discovered at runtime: `categories` is a free-form string array with no
      // documented enumeration, so unknown values must not be dropped.
      categories: categories.map((r) => ({
        category: str(r.CATEGORY),
        n: num(r.N),
        agents: num(r.AGENTS),
      })),
      uncategorizedNegative: num(uncategorized[0]?.N),
      byAgent: byAgent.map((r) => ({
        agentFqn: str(r.AGENT_FQN),
        agentName: str(r.AGENT_NAME),
        total: num(r.TOTAL),
        positive: num(r.POSITIVE),
        negative: num(r.NEGATIVE),
      })),
      items: items.map((r) => ({
        recordId: str(r.RECORD_ID),
        agentFqn: str(r.AGENT_FQN),
        agentName: str(r.AGENT_NAME),
        ts: str(r.FEEDBACK_TS),
        userName: str(r.USER_NAME),
        roleName: str(r.ROLE_NAME),
        isPositive: Boolean(r.IS_POSITIVE),
        message: str(r.FEEDBACK_MESSAGE),
        categories: arr(r.CATEGORIES),
        threadId: str(r.THREAD_ID),
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[api/feedback]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
