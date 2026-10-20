/**
 * @module as-graph/tests/integration/graph/nodes/devops/githubGitlabNodes
 * @summary SAA-1027 Stage 3b: node→service integration coverage for the GitHub
 * and GitLab node kinds.
 * @description The loopback block is **contract** coverage: both DevOps vendors
 * run against a process-local HTTP stub that implements the real service routes
 * and records the emitted request, and it must never be reported as a live
 * PASS. The live success path is credential-gated: GitHub needs
 * `AS_GRAPH_IT_GITHUB_TOKEN` and `AS_GRAPH_IT_GITHUB_REPO` (`owner/repo`);
 * GitLab needs `AS_GRAPH_IT_GITLAB_TOKEN`, `AS_GRAPH_IT_GITLAB_URL` (API base,
 * e.g. `https://gitlab.com/api/v4`) and `AS_GRAPH_IT_GITLAB_PROJECT`. When a
 * variable is absent the case is a SKIP naming it, not a stub-backed success.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { GithubNode } from "../../../../../src/node/devops/github/node";
import { GitlabNode } from "../../../../../src/node/devops/gitlab/node";
import {
  credential,
  clearCredentials,
  runNode,
  setCredential,
} from "../real-service-support";
import { startHttpStub, type HttpStub } from "../loopback-support";
import { credentialGatedIt, envValue } from "../credential-gated";

jest.setTimeout(60000);

const SECRETS = {
  github: "saa1035-github-secret",
  gitlab: "saa1035-gitlab-secret",
} as const;

const CREDENTIALS = {
  github: credential("it-saa1035-GITHUB", "github"),
  gitlab: credential("it-saa1035-GITLAB", "gitlab"),
} as const;

describe("core.devops.* vendor contract (loopback stub; NOT a live-matrix claim)", () => {
  let http: HttpStub;

  beforeAll(async () => {
    http = await startHttpStub((request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const path = decodeURIComponent(request.path);

      if (path === "/github/repos/acme/widgets") {
        return {
          body: {
            id: 1,
            full_name: "acme/widgets",
            default_branch: "main",
          },
        };
      }
      if (path === "/github/repos/acme/widgets/issues") {
        if (request.method === "POST") {
          return {
            body: {
              number: 8,
              title: body.title,
              state: "open",
              html_url: "https://github.example/acme/widgets/issues/8",
              labels: body.labels,
            },
          };
        }
        return {
          body: [
            {
              number: 7,
              title: "real issue",
              state: "open",
              html_url: "https://github.example/acme/widgets/issues/7",
              user: { login: "octocat" },
              labels: [{ name: "bug" }],
            },
            {
              number: 9,
              title: "pull request",
              pull_request: { url: "https://github.example/pulls/9" },
            },
          ],
        };
      }
      if (path === "/github/repos/acme/widgets/issues/7/comments") {
        return {
          body: {
            id: 1001,
            html_url: "https://github.example/acme/widgets/issues/7#c1001",
          },
        };
      }
      if (path === "/github/repos/acme/widgets/pulls") {
        return {
          body: [
            {
              number: 9,
              title: "a pull request",
              state: "open",
              html_url: "https://github.example/acme/widgets/pull/9",
            },
          ],
        };
      }

      if (path === "/gitlab/projects/acme/widgets") {
        return {
          body: {
            id: 11,
            path_with_namespace: "acme/widgets",
            default_branch: "main",
          },
        };
      }
      if (path === "/gitlab/projects/acme/widgets/issues") {
        if (request.method === "POST") {
          return {
            body: {
              id: 501,
              iid: 12,
              title: body.title,
              state: "opened",
              web_url: "https://gitlab.example/acme/widgets/-/issues/12",
              labels: ["bug"],
            },
          };
        }
        return {
          body: [
            {
              id: 501,
              iid: 12,
              title: "gitlab issue",
              state: "opened",
              web_url: "https://gitlab.example/acme/widgets/-/issues/12",
              author: { username: "tanuki" },
              labels: ["bug"],
            },
          ],
        };
      }
      if (path === "/gitlab/projects/acme/widgets/issues/12/notes") {
        return {
          body: {
            id: 601,
            web_url: "https://gitlab.example/acme/widgets/-/issues/12#note_601",
          },
        };
      }
      if (path === "/gitlab/projects/acme/widgets/merge_requests") {
        return {
          body: [
            {
              iid: 13,
              title: "a merge request",
              state: "opened",
              web_url: "https://gitlab.example/acme/widgets/-/merge_requests/13",
            },
          ],
        };
      }

      return { status: 404, body: { error: `unhandled ${path}` } };
    });

    setCredential("it-saa1035-GITHUB", SECRETS.github);
    setCredential("it-saa1035-GITLAB", SECRETS.gitlab);
  });

  afterAll(async () => {
    clearCredentials(
      "it-saa1035-GITHUB",
      "it-saa1035-GITLAB"
    );
    await http.close();
  });

  it("contract: GitHub reads, creates, comments and lists pull requests", async () => {
    const baseUrl = `${http.baseUrl}/github`;
    const before = http.requests.length;
    const repo = await runNode(
      GithubNode,
      "core.devops.github",
      {
        operation: "getRepo",
        owner: "acme",
        repo: "widgets",
        baseUrl,
      },
      {},
      CREDENTIALS.github
    );
    expect(repo.result).toMatchObject({ full_name: "acme/widgets" });
    expect(http.requests[before].headers.authorization).toBe(
      `Bearer ${SECRETS.github}`
    );
    expect(http.requests[before].headers["x-github-api-version"]).toBe(
      "2022-11-28"
    );

    const issues = await runNode(
      GithubNode,
      "core.devops.github",
      {
        operation: "listIssues",
        owner: "acme",
        repo: "widgets",
        state: "open",
        labels: ["bug"],
        limit: 10,
        page: 2,
        baseUrl,
      },
      {},
      CREDENTIALS.github
    );
    expect(issues.result).toEqual([
      expect.objectContaining({
        number: 7,
        title: "real issue",
        user: "octocat",
        labels: ["bug"],
      }),
    ]);
    expect(JSON.stringify(issues.result)).not.toContain("pull request");

    const created = await runNode(
      GithubNode,
      "core.devops.github",
      {
        operation: "createIssue",
        owner: "acme",
        repo: "widgets",
        title: "new issue",
        body: "new body",
        labels: ["bug"],
        assignees: ["octocat"],
        baseUrl,
      },
      {},
      CREDENTIALS.github
    );
    expect(created.number).toBe(8);
    expect(created.url).toBe(
      "https://github.example/acme/widgets/issues/8"
    );

    const commented = await runNode(
      GithubNode,
      "core.devops.github",
      {
        operation: "commentIssue",
        owner: "acme",
        repo: "widgets",
        number: 7,
        body: "a comment",
        baseUrl,
      },
      {},
      CREDENTIALS.github
    );
    expect(commented.result).toEqual({
      id: 1001,
      htmlUrl: "https://github.example/acme/widgets/issues/7#c1001",
    });
    expect(commented.url).toBe(
      "https://github.example/acme/widgets/issues/7#c1001"
    );

    const pulls = await runNode(
      GithubNode,
      "core.devops.github",
      {
        operation: "listPullRequests",
        owner: "acme",
        repo: "widgets",
        state: "open",
        limit: 5,
        baseUrl,
      },
      {},
      CREDENTIALS.github
    );
    expect(pulls.result).toEqual([
      expect.objectContaining({ number: 9, title: "a pull request" }),
    ]);
  });

  it("contract: GitLab reads, creates, comments and lists merge requests", async () => {
    const baseUrl = `${http.baseUrl}/gitlab`;
    const before = http.requests.length;
    const project = await runNode(
      GitlabNode,
      "core.devops.gitlab",
      {
        operation: "getProject",
        projectId: "acme/widgets",
        baseUrl,
      },
      {},
      CREDENTIALS.gitlab
    );
    expect(project.result).toMatchObject({
      path_with_namespace: "acme/widgets",
    });
    expect(http.requests[before].headers["private-token"]).toBe(
      SECRETS.gitlab
    );

    const issues = await runNode(
      GitlabNode,
      "core.devops.gitlab",
      {
        operation: "listIssues",
        projectId: "acme/widgets",
        state: "opened",
        labels: ["bug"],
        search: "gitlab",
        limit: 10,
        page: 2,
        baseUrl,
      },
      {},
      CREDENTIALS.gitlab
    );
    expect(issues.result).toEqual([
      expect.objectContaining({
        iid: 12,
        title: "gitlab issue",
        author: "tanuki",
        labels: ["bug"],
      }),
    ]);

    const created = await runNode(
      GitlabNode,
      "core.devops.gitlab",
      {
        operation: "createIssue",
        projectId: "acme/widgets",
        title: "new issue",
        body: "new body",
        labels: ["bug"],
        assigneeIds: [3],
        baseUrl,
      },
      {},
      CREDENTIALS.gitlab
    );
    expect(created.iid).toBe(12);
    expect(created.url).toBe(
      "https://gitlab.example/acme/widgets/-/issues/12"
    );

    const commented = await runNode(
      GitlabNode,
      "core.devops.gitlab",
      {
        operation: "commentIssue",
        projectId: "acme/widgets",
        iid: 12,
        body: "a comment",
        baseUrl,
      },
      {},
      CREDENTIALS.gitlab
    );
    expect(commented.result).toEqual({
      id: 601,
      webUrl: "https://gitlab.example/acme/widgets/-/issues/12#note_601",
    });
    expect(commented.iid).toBe(12);

    const merges = await runNode(
      GitlabNode,
      "core.devops.gitlab",
      {
        operation: "listMergeRequests",
        projectId: "acme/widgets",
        state: "opened",
        limit: 5,
        baseUrl,
      },
      {},
      CREDENTIALS.gitlab
    );
    expect(merges.result).toEqual([
      expect.objectContaining({ iid: 13, title: "a merge request" }),
    ]);
  });

  it("contract: never echoes a DevOps vendor secret into a node result", async () => {
    const github = await runNode(
      GithubNode,
      "core.devops.github",
      {
        operation: "getRepo",
        owner: "acme",
        repo: "widgets",
        baseUrl: `${http.baseUrl}/github`,
      },
      {},
      CREDENTIALS.github
    );
    const gitlab = await runNode(
      GitlabNode,
      "core.devops.gitlab",
      {
        operation: "getProject",
        projectId: "acme/widgets",
        baseUrl: `${http.baseUrl}/gitlab`,
      },
      {},
      CREDENTIALS.gitlab
    );
    const serialized = JSON.stringify([github, gitlab]);
    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
  });
});

/**
 * Live credential-gated success paths. The loopback block above is contract
 * coverage, not live infrastructure.
 */
describe("core.devops.* live SaaS integration (credential-gated)", () => {
  credentialGatedIt(
    "live: GitHub reads a real repository",
    ["AS_GRAPH_IT_GITHUB_TOKEN", "AS_GRAPH_IT_GITHUB_REPO"],
    async () => {
      const id = "it-live-GITHUB";
      const [owner, repo] = envValue("AS_GRAPH_IT_GITHUB_REPO").split("/");
      setCredential(id, envValue("AS_GRAPH_IT_GITHUB_TOKEN"));
      try {
        const result = await runNode(
          GithubNode,
          "core.devops.github",
          { operation: "getRepo", owner, repo },
          {},
          credential(id, "github")
        );
        expect(result.result).toMatchObject({
          id: expect.any(Number),
          full_name: expect.stringContaining("/"),
        });
        expect(JSON.stringify(result)).not.toContain(
          envValue("AS_GRAPH_IT_GITHUB_TOKEN")
        );
      } finally {
        clearCredentials(id);
      }
    }
  );

  credentialGatedIt(
    "live: GitLab reads a real project",
    [
      "AS_GRAPH_IT_GITLAB_TOKEN",
      "AS_GRAPH_IT_GITLAB_URL",
      "AS_GRAPH_IT_GITLAB_PROJECT",
    ],
    async () => {
      const id = "it-live-GITLAB";
      const baseUrl = envValue("AS_GRAPH_IT_GITLAB_URL");
      setCredential(id, envValue("AS_GRAPH_IT_GITLAB_TOKEN"));
      try {
        const result = await runNode(
          GitlabNode,
          "core.devops.gitlab",
          {
            operation: "getProject",
            projectId: envValue("AS_GRAPH_IT_GITLAB_PROJECT"),
            baseUrl,
          },
          {},
          credential(id, "gitlab")
        );
        expect(result.result).toMatchObject({
          id: expect.any(Number),
          path_with_namespace: expect.any(String),
        });
        expect(JSON.stringify(result)).not.toContain(
          envValue("AS_GRAPH_IT_GITLAB_TOKEN")
        );
      } finally {
        clearCredentials(id);
      }
    }
  );
});
