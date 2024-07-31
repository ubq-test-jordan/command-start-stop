import { Context, IssueEvent } from "../../types";

function getAppId(context: Context): number {
  const { env } = context;
  let appId = 0;

  try {
    appId = JSON.parse(env.APP_ID || "0");
  } catch {
    throw new Error("Invalid APP_ID");
  }

  if (typeof appId === "string") {
    appId = parseInt(appId, 10);
  }

  if (!isNaN(appId) && appId > 0) {
    return appId;
  }

  throw new Error("Invalid APP_ID");
}

export async function hasUserBeenUnassigned(context: Context): Promise<boolean> {
  const APP_ID = getAppId(context);
  const events = await getAssignmentEvents(context);
  const senderLogin = context.payload.comment.user?.login.toLowerCase() || context.payload.sender.login.toLowerCase();
  const userAssignments = events.filter((event) => event.assignee?.toLowerCase() === senderLogin);

  if (userAssignments.length === 0) {
    return false;
  }

  const unassignedEvents = userAssignments.filter((event) => event.event === "unassigned");
  const botUnassigned = unassignedEvents.filter((event) => event.actorId === APP_ID);
  const adminUnassigned = unassignedEvents.filter((event) => event.actor?.toLowerCase() !== senderLogin && event.actorId !== APP_ID);
  return botUnassigned.length > 0 || adminUnassigned.length > 0;
}

async function getAssignmentEvents(context: Context) {
  const { repository, issue } = context.payload;
  try {
    const { data } = (await context.octokit.issues.listEventsForTimeline({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: issue.number,
    })) as IssueEvent;

    const events = data
      .filter((event) => event.event === "assigned" || event.event === "unassigned")
      .map((event) => {
        let actor, assignee, createdAt, actorId;

        if ((event.event === "unassigned" || event.event === "assigned") && "actor" in event && event.actor && "assignee" in event && event.assignee) {
          actor = event.actor.login;
          assignee = event.assignee.login;
          createdAt = event.created_at;
          actorId = event.actor.id;
        }

        return {
          event: event.event,
          actor,
          actorId,
          assignee,
          createdAt,
        };
      });

    return events
      .filter((event) => event !== undefined)
      .sort((a, b) => {
        return new Date(a.createdAt || "").getTime() - new Date(b.createdAt || "").getTime();
      });
  } catch (error) {
    const log = context.logger.error("Error while getting assignment events", { error: error as Error });
    throw new Error(log?.logMessage.diff as string);
  }
}
