# 아티클 상세 "관련 글 추천" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 아티클 상세 페이지에서 해시태그가 가장 많이 겹치는 다른 아티클을 최대 2개 "이런 글은 어떠세요?" 섹션으로 추천하고, 클릭 시 해당 아티클로 이동한다.

**Architecture:** `src/lib/queries.ts`에 SQL 기반 겹침-랭킹 쿼리 함수(`getRelatedArticles`)를 추가하고, `src/app/article/[id]/page.tsx`에서 호출해 기존 `linked-formulas`/`lf-*` CSS 클래스를 재사용한 카드 섹션으로 렌더링한다. 새 CSS는 추가하지 않는다.

**Tech Stack:** Next.js (App Router, Server Component), Drizzle ORM (`neon-http`), PostgreSQL `jsonb_array_elements_text`.

**참고 스펙:** `docs/superpowers/specs/2026-07-09-related-articles-design.md`

이 프로젝트에는 DB 의존 쿼리 함수에 대한 자동 테스트 프레임워크가 없다(jest/vitest 미설치, `queries.ts`의 다른 함수들도 테스트 없이 typecheck + 수동 확인으로 검증됨). 이 계획도 동일한 방식을 따른다: 각 태스크는 `npm run typecheck`로 타입 정합성을 확인하고, 마지막 태스크에서 개발 서버로 실제 동작을 확인한다.

---

### Task 1: 데이터 계층 — `getRelatedArticles` 쿼리 함수

**Files:**
- Modify: `src/lib/queries.ts:611` (기존 `getAuthorOtherPosts` 함수 바로 뒤에 추가)

- [ ] **Step 1: `getRelatedArticles` 함수 추가**

`src/lib/queries.ts`의 611번째 줄(`getAuthorOtherPosts` 함수의 닫는 `}` 바로 다음, `// ---- 신뢰등급 계산 헬퍼` 주석 앞) 에 다음 함수를 추가한다:

```ts
/**
 * 해시태그가 가장 많이 겹치는 다른 아티클(cardnews)을 랭킹순으로 반환.
 * 겹치는 태그가 0개인 글은 결과에서 제외된다(HAVING count(*) >= 1).
 */
export async function getRelatedArticles(
  postId: string,
  tags: string[],
  limit = 2,
): Promise<FeedPost[]> {
  if (!tags.length) return [];

  const tagList = sql.join(
    tags.map((t) => sql`${t}`),
    sql`, `,
  );

  const ranked = await db.execute(sql`
    SELECT p.id, count(*)::int AS overlap
    FROM post p
    CROSS JOIN LATERAL jsonb_array_elements_text(p.tags) AS tag
    WHERE p."postType" = 'cardnews'
      AND p.id <> ${postId}
      AND tag IN (${tagList})
    GROUP BY p.id
    HAVING count(*) >= 1
    ORDER BY overlap DESC, p."createdAt" DESC
    LIMIT ${limit}
  `);

  const ids = (ranked.rows as { id: string }[]).map((r) => r.id);
  if (!ids.length) return [];

  const rows = (await db
    .select(postColumns)
    .from(posts)
    .where(inArray(posts.id, ids))) as PostRow[];

  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is PostRow => !!r)
    .map(rowToPost);
}
```

- [ ] **Step 2: 타입체크로 검증**

Run: `npm run typecheck`
Expected: 에러 없이 종료 (기존 에러가 있었다면 그 개수가 늘지 않아야 함).

- [ ] **Step 3: 커밋**

```bash
git add src/lib/queries.ts
git commit -m "feat(queries): 해시태그 겹침 기반 관련 아티클 조회 함수 추가"
```

---

### Task 2: UI 계층 — 아티클 상세 페이지에 "이런 글은 어떠세요?" 섹션 추가

**Files:**
- Modify: `src/app/article/[id]/page.tsx:1-15` (import 추가)
- Modify: `src/app/article/[id]/page.tsx:82-92` (데이터 호출 추가)
- Modify: `src/app/article/[id]/page.tsx:224-230` (렌더링 추가, 키워드 태그 아래·`linked-formulas` 섹션 위)

- [ ] **Step 1: import에 `getRelatedArticles` 추가**

`src/app/article/[id]/page.tsx` 상단 import 블록을 다음과 같이 수정한다:

```ts
import {
  getArticle,
  getAuthorOtherPosts,
  getRelatedArticles,
  getProfile,
  currentUserId,
} from "@/lib/queries";
```

- [ ] **Step 2: 관련 글 데이터 조회 추가**

`src/app/article/[id]/page.tsx`의 82번째 줄, 기존 `otherPosts` 조회 블록 바로 아래에 추가한다:

```ts
  // 우측 사이드바: 작성자의 다른 공식 + 팔로우 상태
  const otherPosts = author
    ? await getAuthorOtherPosts(author.id, post.id, 4)
    : [];

  // 본문: 해시태그 겹침 기반 관련 아티클 추천 (최대 2개)
  const relatedArticles =
    post.tags.length > 0 ? await getRelatedArticles(post.id, post.tags, 2) : [];
```

- [ ] **Step 3: 섹션 렌더링 추가**

`src/app/article/[id]/page.tsx`에서 키워드 태그(`d-tags`) 블록이 끝나는 지점(224번째 줄, `)}`  바로 다음)과 `{/* ===== 이 아티클로 만든 공식(아카이브) 연결 섹션 ... */}` 주석(226번째 줄) 사이에 다음 블록을 추가한다:

```tsx
          {/* 관련 글 추천 — 해시태그 겹침 랭킹, 겹치는 글 없으면 섹션 자체 숨김 */}
          {relatedArticles.length > 0 && (
            <section className="linked-formulas" style={{ marginTop: 28 }}>
              <div className="lf-head">
                <span aria-hidden>🔗</span>이런 글은 어떠세요?
              </div>
              <ul className="lf-list">
                {relatedArticles.map((a) => (
                  <li key={a.id}>
                    <Link href={`/article/${a.id}`} className="lf-item">
                      <div className="lf-main">
                        <span className="lf-name">{a.title}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
```

- [ ] **Step 4: 타입체크로 검증**

Run: `npm run typecheck`
Expected: 에러 없이 종료.

- [ ] **Step 5: 개발 서버로 실제 동작 확인**

Run: `npm run dev`

같은 해시태그를 가진 아티클이 최소 2개 존재하는 상태에서 (없다면 `npm run db:seed`로 시드 데이터 생성 후) 브라우저에서 아티클 상세 페이지(`/article/{id}`)에 접속해 다음을 확인한다:
- 키워드 태그 아래·"이 아티클로 만든 공식" 섹션 위에 "이런 글은 어떠세요?" 섹션이 보인다.
- 카드를 클릭하면 해당 아티클 상세 페이지로 이동한다.
- 겹치는 태그가 있는 다른 아티클이 없는 글(예: 태그가 유니크한 아티클)에서는 섹션이 아예 보이지 않는다.

- [ ] **Step 6: 커밋**

```bash
git add src/app/article/\[id\]/page.tsx
git commit -m "feat(article): 해시태그 겹침 기반 관련 글 추천 섹션 추가"
```

---

## Self-Review 체크리스트 (계획 작성자용, 실행자는 무시)

- 스펙 4개 섹션(데이터 계층/UI 계층/엣지 케이스/비범위) 모두 Task 1·2에 반영됨.
- Placeholder 없음 — 모든 스텝에 실제 코드 포함.
- 타입 일관성: `FeedPost[]`, `PostRow`, `postColumns`, `rowToPost`는 기존 `getAuthorOtherPosts`와 동일한 심볼을 그대로 재사용.
