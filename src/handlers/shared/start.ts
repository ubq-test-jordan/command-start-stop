import { Context, ISSUE_TYPE, Label } from "../../types";
import { isUserCollaborator } from "../../utils/get-user-association";
import { addAssignees, addCommentToIssue, getAssignedIssues, getAvailableOpenedPullRequests, getTimeValue, isParentIssue } from "../../utils/issue";
import { HttpStatusCode, Result } from "../result-types";
import { hasUserBeenUnassigned } from "./check-assignments";
import { checkTaskStale } from "./check-task-stale";
import { generateAssignmentComment, getDeadline } from "./generate-assignment-comment";
import { getUserRoleAndTaskLimit } from "./get-user-task-limit-and-role";
import structuredMetadata from "./structured-metadata";
import { assignTableComment } from "./table";

export async function start(
  context: Context,
  issue: Context<"issue_comment.created">["payload"]["issue"],
  sender: Context["payload"]["sender"],
  teammates: string[]
): Promise<Result> {
  const { logger, config } = context;
  const { taskStaleTimeoutDuration } = config;

  if (!sender) {
    throw logger.error(`Skipping '/start' since there is no sender in the context.`);
  }

  // is it a child issue?
  if (issue.body && isParentIssue(issue.body)) {
    await addCommentToIssue(
      context,
      "```diff\n# Please select a child issue from the specification checklist to work on. The '/start' command is disabled on parent issues.\n```"
    );
    throw logger.error(`Skipping '/start' since the issue is a parent issue`);
  }

  let commitHash: string | null = null;

  try {
    const hashResponse = await context.octokit.rest.repos.getCommit({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      ref: context.payload.repository.default_branch,
    });
    commitHash = hashResponse.data.sha;
  } catch (e) {
    logger.error("Error while getting commit hash", { error: e as Error });
  }

  // is it assignable?

  if (issue.state === ISSUE_TYPE.CLOSED) {
    throw logger.error("This issue is closed, please choose another.", { issueNumber: issue.number });
  }

  const assignees = issue?.assignees ?? [];

  // find out if the issue is already assigned
  if (assignees.length !== 0) {
    const isCurrentUserAssigned = !!assignees.find((assignee) => assignee?.login === sender.login);
    throw logger.error(
      isCurrentUserAssigned ? "You are already assigned to this task." : "This issue is already assigned. Please choose another unassigned task.",
      { issueNumber: issue.number }
    );
  }

  teammates.push(sender.login);

  const toAssign = [];
  // check max assigned issues
  for (const user of teammates) {
    if (await handleTaskLimitChecks(user, context, logger, sender.login)) {
      toAssign.push(user);
    }
  }

  let error: string | null = null;

  if (toAssign.length === 0 && teammates.length > 1) {
    error = "All teammates have reached their max task limit. Please close out some tasks before assigning new ones.";
  } else if (toAssign.length === 0) {
    error = "You have reached your max task limit. Please close out some tasks before assigning new ones.";
  }

  if (error) {
    throw logger.error(error, { issueNumber: issue.number });
  }

  const labels = issue.labels ?? [];
  const priceLabel = labels.find((label: Label) => label.name.startsWith("Price: "));

  if (!priceLabel) {
    throw logger.error("No price label is set to calculate the duration", { issueNumber: issue.number });
  }

  // Checks if non-collaborators can be assigned to the issue
  for (const label of labels) {
    if (label.description?.includes("collaborator only")) {
      for (const user of toAssign) {
        if (!(await isUserCollaborator(context, user))) {
          throw logger.error("Only collaborators can be assigned to this issue.", {
            username: user,
          });
        }
      }
    }
  }

  const deadline = getDeadline(labels);
  const toAssignIds = await fetchUserIds(context, toAssign);

  const assignmentComment = await generateAssignmentComment(context, issue.created_at, issue.number, sender.id, deadline);
  const logMessage = logger.info("Task assigned successfully", {
    taskDeadline: assignmentComment.deadline,
    taskAssignees: toAssignIds,
    priceLabel,
    revision: commitHash?.substring(0, 7),
  });
  const metadata = structuredMetadata.create("Assignment", logMessage);

  // add assignee
  await addAssignees(context, issue.number, toAssign);

  const isTaskStale = checkTaskStale(getTimeValue(taskStaleTimeoutDuration), issue.created_at);

  await addCommentToIssue(
    context,
    [
      assignTableComment({
        isTaskStale,
        daysElapsedSinceTaskCreation: assignmentComment.daysElapsedSinceTaskCreation,
        taskDeadline: assignmentComment.deadline,
        registeredWallet: assignmentComment.registeredWallet,
      }),
      assignmentComment.tips,
      metadata,
    ].join("\n") as string
  );

  return { content: "Task assigned successfully", status: HttpStatusCode.OK };
}

async function fetchUserIds(context: Context, username: string[]) {
  const ids = [];

  for (const user of username) {
    const { data } = await context.octokit.rest.users.getByUsername({
      username: user,
    });

    ids.push(data.id);
  }

  if (ids.filter((id) => !id).length > 0) {
    throw new Error("Error while fetching user ids");
  }

  return ids;
}

async function handleTaskLimitChecks(username: string, context: Context, logger: Context["logger"], sender: string) {
  const { approved, changes } = await getAvailableOpenedPullRequests(context, username);
  const assignedIssues = await getAssignedIssues(context, username);
  const { limit } = await getUserRoleAndTaskLimit(context, username);

  const adjustedAssignedIssues = assignedIssues.length - approved.length + changes.length;

  // check for max and enforce max
  if (Math.abs(adjustedAssignedIssues) >= limit) {
    logger.error(username === sender ? "You have reached your max task limit" : `${username} has reached their max task limit`, {
      assignedIssues: assignedIssues.length,
      openedPullRequests: approved.length,
      limit,
    });

    return false;
  }

  if (await hasUserBeenUnassigned(context, username)) {
    throw logger.error(`${username} you were previously unassigned from this task. You cannot be reassigned.`, { username });
  }

  return true;
}
