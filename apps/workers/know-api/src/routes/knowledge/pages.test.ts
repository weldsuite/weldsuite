/**
 * DB-backed tests for WeldKnow pages, version history, trash, favorites and
 * teamspace settings: every route teamspaces.test.ts does not reach, with
 * their refusals (validation, permissions, locks, cycles, missing rows).
 *
 * These tests are also the Rust port's conformance suite ("know" in
 * rust/conformance/suites.json), so each request's whole response counts,
 * not only what the assertions check.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { knowledgeRoutes } from "./index";
import { createTestApp, permissions } from "@weldsuite/worker-kit/testing";
import { createPgliteDb } from "@weldsuite/worker-kit/testing/pglite";
import { schema, type Database } from "@weldsuite/worker-kit/db";

const BASE = "/api/knowledge";
const JSON_HEADERS = { "Content-Type": "application/json" };
const MEMBER_GRANTS = [
  "knowledge:read",
  "knowledge:create",
  "knowledge:update",
  "knowledge:delete",
];

const ALICE = "user_alice";
const BOB = "user_bob";
const CAROL = "user_carol";

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  await db.insert(schema.workspaceMembers).values(
    [ALICE, BOB, CAROL].map((userId) => ({
      id: `wm_${userId}`,
      userId,
      name: userId.replace("user_", ""),
      email: `${userId}@example.com`,
    })),
  );
}, 60_000);

function as(userId: string, grants: string[] = MEMBER_GRANTS) {
  const { request } = createTestApp(BASE, knowledgeRoutes, {
    context: {
      userId,
      permissions: permissions(...grants),
      tenantDb: db,
      workspaceId: "org_know",
      orgId: "org_know",
    },
  });
  return {
    get: (path: string) => request(`${BASE}${path}`),
    send: (method: string, path: string, body?: unknown) =>
      request(`${BASE}${path}`, {
        method,
        headers: JSON_HEADERS,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    raw: (method: string, path: string, body: string) =>
      request(`${BASE}${path}`, { method, headers: JSON_HEADERS, body }),
  };
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

interface Page {
  id: string;
  spaceId: string;
  parentId: string | null;
  position: number;
  title: string;
  isLocked: boolean;
  contentJson: Record<string, unknown>[];
}

async function space(caller = as(ALICE), name = "Docs", visibility = "open") {
  const res = await caller.send("POST", "/spaces", { name, visibility });
  expect(res.status).toBe(201);
  return data<{ id: string }>(res);
}

async function page(
  spaceId: string,
  body: Record<string, unknown> = {},
  caller = as(ALICE),
) {
  const res = await caller.send("POST", "/pages", {
    spaceId,
    title: "Page",
    ...body,
  });
  expect(res.status).toBe(201);
  return data<Page>(res);
}

describe("pages", () => {
  it("creates, reads, edits and autosaves a page", async () => {
    const docs = await space();
    const created = await page(docs.id, {
      title: "",
      icon: "book",
      contentJson: [{ type: "heading" }],
    });
    expect(created).toMatchObject({
      title: "Untitled",
      icon: "book",
      position: 0,
      isLocked: false,
    });
    expect((await page(docs.id)).position).toBe(1);

    const read = await as(ALICE).get(`/pages/${created.id}`);
    expect(read.status).toBe(200);
    expect(await data<Page>(read)).toMatchObject({
      id: created.id,
      contentJson: [{ type: "heading" }],
    });

    const edited = await as(ALICE).send("PATCH", `/pages/${created.id}`, {
      title: "Guide",
      coverImage: null,
      isLocked: false,
    });
    expect(edited.status).toBe(200);
    expect(await data<Page>(edited)).toMatchObject({
      title: "Guide",
      coverImage: null,
    });

    const blocks = [{ type: "paragraph", content: "Hello" }];
    const saved = await as(ALICE).send("PUT", `/pages/${created.id}/content`, {
      contentJson: blocks,
      contentText: "Hello",
    });
    expect(saved.status).toBe(200);
    expect(await data<{ id: string }>(saved)).toEqual({ id: created.id });
    expect(
      await data<Page>(await as(ALICE).get(`/pages/${created.id}`)),
    ).toMatchObject({ contentJson: blocks, contentText: "Hello" });

    // Autosave snapshots at most every ten minutes.
    await as(ALICE).send("PUT", `/pages/${created.id}/content`, {
      contentJson: [],
    });
    const versions = await data<{ label: string | null }[]>(
      await as(ALICE).get(`/pages/${created.id}/versions`),
    );
    expect(versions).toHaveLength(1);
    expect(versions[0].label).toBeNull();
  });

  it("keeps locked pages as they are", async () => {
    const docs = await space();
    const locked = await page(docs.id);
    expect(
      (await as(ALICE).send("PATCH", `/pages/${locked.id}`, { isLocked: true }))
        .status,
    ).toBe(200);
    expect(
      (
        await as(ALICE).send("PUT", `/pages/${locked.id}/content`, {
          contentJson: [],
        })
      ).status,
    ).toBe(409);
    // Metadata stays editable, so the page can be unlocked again.
    expect(
      (
        await as(ALICE).send("PATCH", `/pages/${locked.id}`, {
          isLocked: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await as(ALICE).send("PUT", `/pages/${locked.id}/content`, {
          contentJson: [],
        })
      ).status,
    ).toBe(200);
  });

  it("validates bodies like the schemas", async () => {
    const docs = await space();
    const target = await page(docs.id);
    expect((await as(ALICE).send("POST", "/pages", {})).status).toBe(400);
    expect(
      (
        await as(ALICE).send("POST", "/pages", {
          spaceId: docs.id,
          contentJson: [1],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await as(ALICE).send("POST", "/pages", {
          spaceId: docs.id,
          title: "x".repeat(501),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await as(ALICE).send("PATCH", `/pages/${target.id}`, {
          title: 5,
          isLocked: "yes",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await as(ALICE).send("PUT", `/pages/${target.id}/content`, {
          contentJson: "blocks",
        })
      ).status,
    ).toBe(400);
    expect(
      (await as(ALICE).send("PUT", `/pages/${target.id}/content`, {})).status,
    ).toBe(400);
    expect((await as(ALICE).raw("POST", "/pages", "{not json")).status).toBe(
      400,
    );
  });

  it("answers 404 for pages that do not exist or cannot be seen", async () => {
    expect((await as(ALICE).get("/pages/kpag_missing")).status).toBe(404);
    expect(
      (await as(ALICE).send("PATCH", "/pages/kpag_missing", { title: "x" }))
        .status,
    ).toBe(404);
    expect(
      (await as(ALICE).send("POST", "/pages", { spaceId: "kspc_missing" }))
        .status,
    ).toBe(404);

    const closed = await space(as(ALICE), "Closed", "closed");
    const secret = await page(closed.id);
    expect((await as(BOB).get(`/pages/${secret.id}`)).status).toBe(404);
    expect((await as(BOB).get(`/pages/${secret.id}/versions`)).status).toBe(
      404,
    );
    expect(
      (await as(BOB).send("POST", "/pages", { spaceId: closed.id })).status,
    ).toBe(403);
  });

  it("needs the workspace permission for each action", async () => {
    const docs = await space();
    const target = await page(docs.id);
    const reader = as(ALICE, ["knowledge:read"]);
    expect((await reader.get(`/pages/${target.id}`)).status).toBe(200);
    expect(
      (await reader.send("POST", "/pages", { spaceId: docs.id })).status,
    ).toBe(403);
    expect(
      (await reader.send("PATCH", `/pages/${target.id}`, { title: "x" }))
        .status,
    ).toBe(403);
    expect((await reader.send("DELETE", `/pages/${target.id}`)).status).toBe(
      403,
    );
    expect((await as(ALICE, []).get("/pages/tree")).status).toBe(403);
  });
});

describe("page tree and moves", () => {
  it("lists the tree, moves pages and refuses cycles", async () => {
    const docs = await space(as(ALICE), "Handbook");
    const root = await page(docs.id, { title: "Root" });
    const child = await page(docs.id, { title: "Child", parentId: root.id });
    const grandchild = await page(docs.id, {
      title: "Grandchild",
      parentId: child.id,
    });

    const tree = await as(ALICE).get(`/pages/tree?spaceId=${docs.id}`);
    expect(tree.status).toBe(200);
    expect((await data<Page[]>(tree)).map((p) => p.title)).toEqual([
      "Root",
      "Child",
      "Grandchild",
    ]);
    expect(
      await data<Page[]>(await as(ALICE).get("/pages/tree?spaceId=kspc_other")),
    ).toEqual([]);

    const cycle = await as(ALICE).send("POST", `/pages/${root.id}/move`, {
      parentId: grandchild.id,
    });
    expect(cycle.status).toBe(400);
    expect(
      (
        await as(ALICE).send("POST", `/pages/${root.id}/move`, {
          parentId: root.id,
        })
      ).status,
    ).toBe(400);

    const lifted = await as(ALICE).send(
      "POST",
      `/pages/${grandchild.id}/move`,
      { parentId: null },
    );
    expect(lifted.status).toBe(200);
    expect(await data<Page>(lifted)).toMatchObject({
      parentId: null,
      position: 1,
    });

    const placed = await as(ALICE).send("POST", `/pages/${child.id}/move`, {
      parentId: null,
      position: 7,
    });
    expect(await data<Page>(placed)).toMatchObject({
      parentId: null,
      position: 7,
    });

    expect(
      (await as(ALICE).send("POST", `/pages/${child.id}/move`, {})).status,
    ).toBe(400);
    expect(
      (
        await as(ALICE).send("POST", `/pages/${child.id}/move`, {
          parentId: null,
          position: -1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await as(ALICE).send("POST", `/pages/${child.id}/move`, {
          parentId: null,
          position: 1.5,
        })
      ).status,
    ).toBe(400);
  });

  it("carries the subtree to another space", async () => {
    const from = await space(as(ALICE), "From");
    const to = await space(as(ALICE), "To");
    const root = await page(from.id, { title: "Root" });
    const child = await page(from.id, { title: "Child", parentId: root.id });
    const other = await page(to.id, { title: "Other" });

    // A parent in the space the page is not moving to is refused.
    expect(
      (
        await as(ALICE).send("POST", `/pages/${root.id}/move`, {
          parentId: other.id,
        })
      ).status,
    ).toBe(400);

    const moved = await as(ALICE).send("POST", `/pages/${root.id}/move`, {
      parentId: other.id,
      spaceId: to.id,
    });
    expect(moved.status).toBe(200);
    expect(await data<Page>(moved)).toMatchObject({
      spaceId: to.id,
      parentId: other.id,
      position: 0,
    });
    expect(
      await data<Page>(await as(ALICE).get(`/pages/${child.id}`)),
    ).toMatchObject({ spaceId: to.id });

    // Moving into a space the caller cannot write to is refused.
    const closed = await space(as(BOB), "Bob only", "closed");
    expect(
      (
        await as(ALICE).send("POST", `/pages/${root.id}/move`, {
          parentId: null,
          spaceId: closed.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await as(ALICE).send("POST", "/pages", {
          spaceId: from.id,
          parentId: other.id,
        })
      ).status,
    ).toBe(400);
  });
});

describe("trash", () => {
  it("trashes a subtree and restores it", async () => {
    const docs = await space(as(ALICE), "Trash");
    const parent = await page(docs.id, { title: "Parent" });
    const child = await page(docs.id, { title: "Child", parentId: parent.id });

    expect((await as(ALICE).send("DELETE", `/pages/${parent.id}`)).status).toBe(
      204,
    );
    expect((await as(ALICE).get(`/pages/${child.id}`)).status).toBe(404);
    const trash = await data<{ id: string }[]>(await as(ALICE).get("/trash"));
    expect(trash.map((p) => p.id)).toEqual(
      expect.arrayContaining([parent.id, child.id]),
    );
    expect(
      await data<Page[]>(await as(ALICE).get(`/pages/tree?spaceId=${docs.id}`)),
    ).toEqual([]);

    // Someone who cannot write in the space cannot restore from it.
    expect(
      (await as(BOB).send("POST", `/pages/${child.id}/restore`)).status,
    ).toBe(403);

    // The child comes back first: its parent is still in the trash, so it moves to the top.
    const child2 = await as(ALICE).send("POST", `/pages/${child.id}/restore`);
    expect(child2.status).toBe(200);
    expect(await data<Page>(child2)).toMatchObject({
      parentId: null,
      deletedAt: null,
    });

    const parent2 = await as(ALICE).send("POST", `/pages/${parent.id}/restore`);
    expect(await data<Page>(parent2)).toMatchObject({
      id: parent.id,
      parentId: null,
      position: 1,
    });
    expect(
      (await as(ALICE).send("POST", `/pages/${parent.id}/restore`)).status,
    ).toBe(404);
  });

  it("cannot restore into a deleted space", async () => {
    const docs = await space(as(ALICE), "Gone");
    const lost = await page(docs.id);
    expect((await as(ALICE).send("DELETE", `/spaces/${docs.id}`)).status).toBe(
      204,
    );
    expect((await as(ALICE).get(`/spaces/${docs.id}/members`)).status).toBe(
      404,
    );
    expect(
      (await as(ALICE).send("POST", `/pages/${lost.id}/restore`)).status,
    ).toBe(409);
  });
});

describe("versions", () => {
  it("names, reads and restores versions", async () => {
    const docs = await space(as(ALICE), "Versions");
    const target = await page(docs.id, {
      contentJson: [{ type: "paragraph", text: "v1" }],
    });

    const named = await as(ALICE).send("POST", `/pages/${target.id}/versions`, {
      label: "First",
    });
    expect(named.status).toBe(201);
    const v1 = await data<{ id: string; label: string; content: unknown }>(
      named,
    );
    expect(v1).toMatchObject({
      label: "First",
      content: [{ type: "paragraph", text: "v1" }],
    });
    expect(
      (
        await as(ALICE).send("POST", `/pages/${target.id}/versions`, {
          label: "x".repeat(256),
        })
      ).status,
    ).toBe(400);

    const one = await as(ALICE).get(`/pages/${target.id}/versions/${v1.id}`);
    expect(one.status).toBe(200);
    expect(
      (await as(ALICE).get(`/pages/${target.id}/versions/kver_missing`)).status,
    ).toBe(404);

    await as(ALICE).send("PUT", `/pages/${target.id}/content`, {
      contentJson: [{ type: "paragraph", text: "v2" }],
    });
    const restored = await as(ALICE).send(
      "POST",
      `/pages/${target.id}/versions/${v1.id}/restore`,
    );
    expect(restored.status).toBe(200);
    expect(await data<Page>(restored)).toMatchObject({
      contentJson: [{ type: "paragraph", text: "v1" }],
    });
    const labels = (
      await data<{ label: string | null }[]>(
        await as(ALICE).get(`/pages/${target.id}/versions`),
      )
    ).map((v) => v.label);
    expect(labels).toContain("Before restore");
    expect(
      (
        await as(ALICE).send(
          "POST",
          `/pages/${target.id}/versions/kver_missing/restore`,
        )
      ).status,
    ).toBe(404);

    await as(ALICE).send("PATCH", `/pages/${target.id}`, { isLocked: true });
    expect(
      (
        await as(ALICE).send(
          "POST",
          `/pages/${target.id}/versions/${v1.id}/restore`,
        )
      ).status,
    ).toBe(409);

    // Reading is open to everyone in an open teamspace; naming a version takes the editor role.
    expect((await as(BOB).get(`/pages/${target.id}/versions`)).status).toBe(
      200,
    );
    expect(
      (await as(BOB).send("POST", `/pages/${target.id}/versions`, {})).status,
    ).toBe(403);
  });
});

describe("favorites", () => {
  it("adds once, lists and removes", async () => {
    const docs = await space(as(ALICE), "Favorites");
    const first = await page(docs.id, { title: "First" });
    const second = await page(docs.id, { title: "Second" });

    const added = await as(ALICE).send("POST", "/favorites", {
      pageId: first.id,
    });
    expect(added.status).toBe(201);
    const again = await as(ALICE).send("POST", "/favorites", {
      pageId: first.id,
    });
    expect(again.status).toBe(200);
    expect((await data<{ id: string }>(again)).id).toBe(
      (await data<{ id: string }>(added)).id,
    );
    expect(
      (await as(ALICE).send("POST", "/favorites", { pageId: second.id }))
        .status,
    ).toBe(201);

    const list = await data<
      { pageId: string; position: number; title: string }[]
    >(await as(ALICE).get("/favorites"));
    expect(list.map((f) => [f.title, f.position])).toEqual([
      ["First", 0],
      ["Second", 1],
    ]);
    // Favorites are per person.
    expect(await data<unknown[]>(await as(BOB).get("/favorites"))).toEqual([]);

    expect(
      (await as(ALICE).send("DELETE", `/favorites/${first.id}`)).status,
    ).toBe(204);
    expect(
      await data<unknown[]>(await as(ALICE).get("/favorites")),
    ).toHaveLength(1);

    expect((await as(ALICE).send("POST", "/favorites", {})).status).toBe(400);
    expect(
      (await as(ALICE).send("POST", "/favorites", { pageId: "kpag_missing" }))
        .status,
    ).toBe(404);
  });
});

describe("teamspace settings and members", () => {
  it("lets an owner edit the teamspace and its members", async () => {
    const team = await space(as(ALICE), "Team", "closed");

    const renamed = await as(ALICE).send("PATCH", `/spaces/${team.id}`, {
      name: "Renamed",
      icon: null,
      color: "blue",
      sortOrder: 3,
    });
    expect(renamed.status).toBe(200);
    expect(await data<Record<string, unknown>>(renamed)).toMatchObject({
      name: "Renamed",
      icon: null,
      color: "blue",
      sortOrder: 3,
    });
    expect(
      (await as(ALICE).send("PATCH", `/spaces/${team.id}`, { isDefault: true }))
        .status,
    ).toBe(403);
    expect(
      (
        await as(ALICE).send("PATCH", `/spaces/${team.id}`, {
          visibility: "secret",
        })
      ).status,
    ).toBe(400);
    expect((await as(ALICE).send("POST", "/spaces", { name: "" })).status).toBe(
      400,
    );

    const teammates = await data<{ userId: string }[]>(
      await as(ALICE).get("/teammates"),
    );
    expect(teammates.map((t) => t.userId)).toEqual([ALICE, BOB, CAROL]);

    expect(
      (
        await as(ALICE).send("POST", `/spaces/${team.id}/members`, {
          userId: "user_nobody",
          role: "editor",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as(ALICE).send("POST", `/spaces/${team.id}/members`, {
          userId: BOB,
          role: "boss",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await as(ALICE).send("POST", `/spaces/${team.id}/members`, {
          userId: BOB,
          role: "editor",
        })
      ).status,
    ).toBe(201);
    // Adding someone who is in already changes their role.
    expect(
      (
        await as(ALICE).send("POST", `/spaces/${team.id}/members`, {
          userId: BOB,
          role: "viewer",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await as(ALICE).send("PATCH", `/spaces/${team.id}/members/${BOB}`, {
          role: "editor",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await as(ALICE).send("PATCH", `/spaces/${team.id}/members/${CAROL}`, {
          role: "editor",
        })
      ).status,
    ).toBe(404);

    const members = await data<{ userId: string; role: string }[]>(
      await as(ALICE).get(`/spaces/${team.id}/members`),
    );
    expect(members.map((m) => [m.userId, m.role])).toEqual([
      [ALICE, "owner"],
      [BOB, "editor"],
    ]);

    // Joining twice keeps the role; an editor cannot delete the teamspace.
    expect(
      await data<{ role: string }>(
        await as(BOB).send("POST", `/spaces/${team.id}/join`),
      ),
    ).toMatchObject({ role: "editor" });
    expect((await as(BOB).send("DELETE", `/spaces/${team.id}`)).status).toBe(
      403,
    );
    expect(
      (await as(CAROL).send("POST", `/spaces/${team.id}/leave`)).status,
    ).toBe(404);
    expect((await as(ALICE).send("DELETE", `/spaces/${team.id}`)).status).toBe(
      204,
    );
    expect(
      (await as(ALICE).send("PATCH", `/spaces/${team.id}`, { name: "Again" }))
        .status,
    ).toBe(404);
  });
});
