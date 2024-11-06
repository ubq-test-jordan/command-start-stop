import { RestEndpointMethodTypes } from "@octokit/rest";
import { Endpoints } from "@octokit/types";
import ms from "ms";
import { Context } from "../types/context";
import { GitHubIssueSearch, Review } from "../types/payload";
import { getLinkedPullRequests, GetLinkedResults } from "./get-linked-prs";
import { getAllPullRequestsFallback, getAssignedIssuesFallback } from "./get-pull-requests-fallback";

export function isParentIssue(body: string) {
  const parentPattern = /-\s+\[( |x)\]\s+#\d+/;
  return body.match(parentPattern);
}

export async function getAssignedIssues(context: Context, username: string) {
  const payload = context.payload;

  try {
    return await context.octokit
      .paginate(context.octokit.rest.search.issuesAndPullRequests, {
        q: `org:${payload.repository.owner.login} assignee:${username} is:open is:issue`,
        per_page: 100,
        order: "desc",
        sort: "created",
      })
      .then((issues) =>
        issues.filter((issue) => {
          return issue.state === "open" && (issue.assignee?.login === username || issue.assignees?.some((assignee) => assignee.login === username));
        })
      );
  } catch (err) {
    context.logger.info("Will try re-fetching assigned issues...", { error: err as Error });
    return getAssignedIssuesFallback(context, username);
  }
}

export async function addCommentToIssue(context: Context, message: string | null) {
  if (!message) {
    context.logger.error("Message is not defined");
    return;
  }

  if (!("issue" in context.payload)) {
    context.logger.error("Cannot post without a referenced issue.");
    return;
  }
  const { payload } = context;

  try {
    await context.octokit.rest.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.issue.number,
      body: message,
    });
  } catch (err: unknown) {
    throw new Error(context.logger.error("Adding a comment failed!", { error: err as Error }).logMessage.raw);
  }
}

// Pull Requests

export async function closePullRequest(context: Context, results: GetLinkedResults) {
  const { payload } = context;
  try {
    await context.octokit.rest.pulls.update({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pull_number: results.number,
      state: "closed",
    });
  } catch (err: unknown) {
    throw new Error(context.logger.error("Closing pull requests failed!", { error: err as Error }).logMessage.raw);
  }
}

export async function closePullRequestForAnIssue(context: Context, issueNumber: number, repository: Context["payload"]["repository"], author: string) {
  const { logger } = context;
  if (!issueNumber) {
    throw new Error(
      logger.error("Issue is not defined", {
        issueNumber,
        repository: repository.name,
      }).logMessage.raw
    );
  }

  const linkedPullRequests = await getLinkedPullRequests(context, {
    owner: repository.owner.login,
    repository: repository.name,
    issue: issueNumber,
  });

  if (!linkedPullRequests.length) {
    return logger.info(`No linked pull requests to close`);
  }

  logger.info(`Opened prs`, { author, linkedPullRequests });
  let comment = "```diff\n# These linked pull requests are closed: ";

  let isClosed = false;

  for (const pr of linkedPullRequests) {
    /**
     * If the PR author is not the same as the issue author, skip the PR
     * If the PR organization is not the same as the issue organization, skip the PR
     *
     * Same organization and author, close the PR
     */
    if (pr.author !== author || pr.organization !== repository.owner.login) {
      continue;
    } else {
      const isLinked = issueLinkedViaPrBody(pr.body, issueNumber);
      if (!isLinked) {
        logger.info(`Issue is not linked to the PR`, { issueNumber, prNumber: pr.number });
        continue;
      }
      await closePullRequest(context, pr);
      comment += ` ${pr.href} `;
      isClosed = true;
    }
  }

  if (!isClosed) {
    return logger.info(`No PRs were closed`);
  }

  return logger.info(comment);
}

async function confirmMultiAssignment(context: Context, issueNumber: number, usernames: string[]) {
  const { logger, payload, octokit } = context;

  if (usernames.length < 2) {
    return;
  }

  const { private: isPrivate } = payload.repository;

  const {
    data: { assignees },
  } = await octokit.rest.issues.get({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: issueNumber,
  });

  if (!assignees?.length) {
    throw logger.error("We detected that this task was not assigned to anyone. Please report this to the maintainers.", { issueNumber, usernames });
  }

  if (isPrivate && assignees?.length <= 1) {
    const log = logger.info("This task belongs to a private repo and can only be assigned to one user without an official paid GitHub subscription.", {
      issueNumber,
    });
    await addCommentToIssue(context, log?.logMessage.diff as string);
  }
}

export async function addAssignees(context: Context, issueNo: number, assignees: string[]) {
  const payload = context.payload;

  try {
    await context.octokit.rest.issues.addAssignees({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: issueNo,
      assignees,
    });
  } catch (e: unknown) {
    throw new Error(context.logger.error("Adding the assignee failed", { assignee: assignees, issueNo, error: e as Error }).logMessage.raw);
  }

  await confirmMultiAssignment(context, issueNo, assignees);
}

async function getAllPullRequests(context: Context, state: Endpoints["GET /repos/{owner}/{repo}/pulls"]["parameters"]["state"] = "open", username: string) {
  const { payload } = context;
  const query: RestEndpointMethodTypes["search"]["issuesAndPullRequests"]["parameters"] = {
    q: `org:${payload.repository.owner.login} author:${username} state:${state} is:pr`,
    per_page: 100,
    order: "desc",
    sort: "created",
  };

  try {
    return (await context.octokit.paginate(context.octokit.rest.search.issuesAndPullRequests, query)) as GitHubIssueSearch["items"];
  } catch (err: unknown) {
    throw new Error(context.logger.error("Fetching all pull requests failed!", { error: err as Error, query }).logMessage.raw);
  }
}

export async function getAllPullRequestsWithRetry(
  context: Context,
  state: Endpoints["GET /repos/{owner}/{repo}/pulls"]["parameters"]["state"],
  username: string
) {
  try {
    return await getAllPullRequests(context, state, username);
  } catch (error) {
    context.logger.info("Will retry re-fetching all pull requests...", { error: error as Error });
    return getAllPullRequestsFallback(context, state, username);
  }
}

export async function getAllPullRequestReviews(context: Context, pullNumber: number, owner: string, repo: string) {
  const {
    config: { rolesWithReviewAuthority },
  } = context;
  try {
    return (
      await context.octokit.paginate(context.octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      })
    ).filter((review) => rolesWithReviewAuthority.includes(review.author_association)) as Review[];
  } catch (err: unknown) {
    throw new Error(context.logger.error("Fetching all pull request reviews failed!", { error: err as Error }).logMessage.raw);
  }
}

async function getReviewRequestsTimeline(context: Context, pullNumber: number, owner: string, repo: string) {
  try {
    return await context.octokit.paginate(
      context.octokit.rest.issues.listEventsForTimeline,
      {
        owner,
        repo,
        issue_number: pullNumber,
        per_page: 100,
      },
      (response) =>
        (
          response.data as Array<{
            created_at: string | number | Date;
            event: string;
          }>
        ).filter((event) => event.event === "review_requested" || event.event === "review_request_removed")
    );
  } catch (error) {
    console.error("Error fetching review request timeline events:", error);
    return [];
  }
}

async function getLatestReviewStatus(context: Context, owner: string, repo: string, pullNumber: number) {
  const query = `
    query($owner: String!, $repo: String!, $pullNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pullNumber) {
          reviews(last: 10) {
            nodes {
              state
              submittedAt
            }
          }
        }
      }
    }
  `;

  const params = { owner, repo, pullNumber };
  const result = await context.octokit.graphql(query, params);

  const reviewNodes = result.repository.pullRequest.reviews.nodes;

  // Check if any review has "CHANGES_REQUESTED"
  const hasUnresolvedChanges = reviewNodes.some((review: { state: string }) => review.state === "CHANGES_REQUESTED");

  return {
    latestReview: reviewNodes[reviewNodes.length - 1],
    hasUnresolvedChanges,
  };
}

export function getOwnerRepoFromHtmlUrl(url: string) {
  const parts = url.split("/");
  if (parts.length < 5) {
    throw new Error("Invalid URL");
  }
  return {
    owner: parts[3],
    repo: parts[4],
  };
}

export async function getAvailableOpenedPullRequests(context: Context, username: string) {
  const { reviewDelayTolerance } = context.config;
  if (!reviewDelayTolerance) return { approved: [], changes: [] };

  const openedPullRequests = await getOpenedPullRequestsForUser(context, username);
  const approved = [] as unknown[];
  const changes = [] as unknown[];

  for (let i = 0; openedPullRequests && i < openedPullRequests.length; i++) {
    const openedPullRequest = openedPullRequests[i];
    if (!openedPullRequest) continue;
    const { owner, repo } = getOwnerRepoFromHtmlUrl(openedPullRequest.html_url);

    const { latestReview, hasUnresolvedChanges } = await getLatestReviewStatus(context, owner, repo, openedPullRequest.number);
    const latestReviewState = latestReview?.state;

    if (latestReviewState === "APPROVED" || !hasUnresolvedChanges) {
      approved.push(openedPullRequest);
      continue;
    }

    if (latestReviewState === "CHANGES_REQUESTED") {
      changes.push(openedPullRequest);
      const lastChangesRequestedTime = latestReview?.submittedAt ? new Date(latestReview.submittedAt).getTime() : null;

      const reviewRequests = await getReviewRequestsTimeline(context, openedPullRequest.number, owner, repo);
      const isReviewRequestedAfterChanges = lastChangesRequestedTime
        ? reviewRequests.some((request) => new Date(request.created_at).getTime() > lastChangesRequestedTime)
        : false;

      if (isReviewRequestedAfterChanges) {
        approved.push(openedPullRequest);
        changes.pop();
        continue;
      }
    }

    if (!latestReview && new Date().getTime() - new Date(openedPullRequest.created_at).getTime() >= getTimeValue(reviewDelayTolerance)) {
      approved.push(openedPullRequest);
    }
  }

  return { approved, changes };
}

export function getTimeValue(timeString: string): number {
  const timeValue = ms(timeString);

  if (!timeValue || timeValue <= 0 || isNaN(timeValue)) {
    throw new Error("Invalid config time value");
  }

  return timeValue;
}

async function getOpenedPullRequestsForUser(context: Context, username: string): Promise<ReturnType<typeof getAllPullRequestsWithRetry>> {
  return getAllPullRequestsWithRetry(context, "open", username);
}

/**
 * Extracts the task id from the PR body. The format is:
 * `Resolves #123`
 * `Fixes https://github.com/.../issues/123`
 * `Closes #123`
 * `Depends on #123`
 * `Related to #123`
 */
export function issueLinkedViaPrBody(prBody: string | null, issueNumber: number): boolean {
  if (!prBody) {
    return false;
  }
  const regex = // eslint-disable-next-line no-useless-escape
    /(?:Resolves|Fixes|Closes|Depends on|Related to) #(\d+)|https:\/\/(?:www\.)?github.com\/([^\/]+)\/([^\/]+)\/(issue|issues)\/(\d+)|#(\d+)/gi;

  const containsHtmlComment = /<!-*[\s\S]*?-*>/g;
  prBody = prBody?.replace(containsHtmlComment, ""); // Remove HTML comments

  const matches = prBody?.match(regex);

  if (!matches) {
    return false;
  }

  let issueId;

  matches.map((match) => {
    if (match.startsWith("http")) {
      // Extract the issue number from the URL
      const urlParts = match.split("/");
      issueId = urlParts[urlParts.length - 1];
    } else {
      // Extract the issue number directly from the hashtag
      const hashtagParts = match.split("#");
      issueId = hashtagParts[hashtagParts.length - 1]; // The issue number follows the '#'
    }
  });

  return issueId === issueNumber.toString();
}
