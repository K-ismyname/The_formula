# 아티클 상세 "관련 글 추천" 설계

> 작성일: 2026-07-09 · 브랜치: `main`
> 담당 역할: 해시태그 겹침 기반 아티클 추천 기능

## 1. 목표

아티클 상세 페이지에서, 현재 글과 해시태그가 가장 많이 겹치는 다른 아티클을 최대 2개
"이런 글은 어떠세요?" 섹션으로 추천한다. 클릭하면 해당 아티클로 이동한다.

## 2. 범위

- 대상 페이지: `src/app/article/[id]/page.tsx` (아티클/카드뉴스 상세)만. 포뮬러(아카이브)
  상세 페이지는 이번 범위 아님.
- 추천 후보: `postType = 'cardnews'`인 아티클끼리만. 포뮬러는 후보에서 제외.

## 3. 데이터 계층 — `src/lib/queries.ts`

`getRelatedArticles(postId: string, tags: string[], limit = 2): Promise<FeedPost[]>` 추가.

- `tags`가 빈 배열이면 즉시 `[]` 반환.
- SQL: 기존 `getTopBookmarkTags`와 동일한
  `CROSS JOIN LATERAL jsonb_array_elements_text(p.tags) AS tag` 패턴으로 겹침 개수를 집계.
  - `postType = 'cardnews'`, `id <> postId`, `tag`가 현재 글의 `tags` 중 하나
  - `GROUP BY p.id`, `HAVING count(*) >= 1`
  - `ORDER BY 겹침개수 DESC, "createdAt" DESC`
  - `LIMIT limit`
- 위 쿼리로 정렬된 id 목록만 얻은 뒤, 기존 `postColumns` + `rowToPost` 패턴으로 전체
  필드를 조회하고, id 목록 순서대로 재정렬해서 반환한다 (기존 `getAuthorOtherPosts`와
  동일한 리턴 타입 `FeedPost[]`).

## 4. UI 계층 — `src/app/article/[id]/page.tsx`

- `post.tags.length > 0`일 때만 `getRelatedArticles(post.id, post.tags, 2)` 호출.
- 배치 위치: 키워드 태그(`d-tags`) 섹션 아래, "이 아티클로 만든 공식" 섹션
  (`linked-formulas`) 바로 위.
- 섹션 제목: "이런 글은 어떠세요?"
- 추천 결과가 0개면 섹션 전체를 렌더링하지 않는다 (조건부 렌더링, 빈 상태 문구 없음).
- 1개만 있으면 1개만 표시한다 (2개를 채우기 위한 폴백 로직 없음).
- 카드는 기존 `lf-item`/`am-item`과 비슷한 단순 리스트 스타일: 제목 클릭 시
  `/article/{id}`로 이동.

## 5. 엣지 케이스

| 상황 | 동작 |
|---|---|
| 태그 없는 글 | 섹션 미표시 |
| 겹치는 태그를 가진 다른 아티클이 0개 | 섹션 미표시 |
| 겹치는 아티클이 1개뿐 | 1개만 표시 |
| 겹침 개수가 동률 | 최신순(`createdAt DESC`)으로 우선순위 결정 |

## 6. 비범위 (Out of scope)

- 포뮬러(아카이브) 상세 페이지에는 적용하지 않음.
- 추천 이유(겹치는 태그 목록) UI 노출 안 함 — 제목만 보여준다.
- 클릭 추적/로깅, 추천 알고리즘 A/B 테스트 등은 다루지 않는다.
