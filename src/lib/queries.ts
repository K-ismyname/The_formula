// =============================================================================
// 서버 전용 데이터 접근 레이어 (Drizzle + auth() 세션)
// =============================================================================
// 규칙
// - 모든 함수는 서버 컴포넌트 / 서버 액션 / 라우트핸들러에서만 호출 (DB 직접 접근).
// - 파생 카운트(saveCount / likeCount / followerCount / applicantCount …)는
//   전부 read-time SQL 집계로 계산해 드리프트를 막는다(저장 카운트 캐시 금지).
// - 반환 타입은 src/lib/contract.ts 의 계약(Post/User/Comment/Activity/…)을 따른다.
// - neon-http 드라이버는 트랜잭션 미지원 → 단발 쿼리/집계 위주로 구성.
// =============================================================================
import { db } from "@/db";
import {
  users,
  posts,
  interactions,
  bookmarks,
  follows,
  activities,
  applications,
  conversations,
  messages,
  memberBookmarks,
  type DbUser,
  type DbPost,
} from "@/db/schema";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { auth } from "@/auth";
import { AGENT_CURATOR_ID } from "@/lib/contract";
import type {
  Activity,
  Application,
  Comment,
  CommentNode,
  ConversationSummary,
  Message,
  Post,
  Tier,
  User,
} from "@/lib/contract";
import { computeTrust, WEIGHTS } from "@/lib/trust";

// ---- 세션 헬퍼 ----
/** 현재 로그인 유저 id (없으면 null). 서버 전용. */
export async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

// ---- 공통 집계 서브쿼리(SQL) 헬퍼 ----
// post 별 카운트를 상관 서브쿼리로 계산해 N+1 없이 read-time 집계한다.
const likeCountSql = sql<number>`(
  select count(*)::int from ${interactions} i
  where i."postId" = "post"."id" and i."type" = 'like'
)`;
const commentCountSql = sql<number>`(
  select count(*)::int from ${interactions} i
  where i."postId" = "post"."id" and i."type" = 'comment'
)`;
const viewCountSql = sql<number>`(
  select count(*)::int from ${interactions} i
  where i."postId" = "post"."id" and i."type" = 'view'
)`;
const saveCountSql = sql<number>`(
  select count(*)::int from ${bookmarks} b
  where b."postId" = "post"."id"
)`;

// post select 컬럼 집합(파생 카운트 포함)
const postColumns = {
  id: posts.id,
  postType: posts.postType,
  title: posts.title,
  oneLiner: posts.oneLiner,
  category: posts.category,
  tags: posts.tags,
  difficulty: posts.difficulty,
  workType: posts.workType,
  verified: posts.verified,
  authorType: posts.authorType,
  authorId: posts.authorId,
  authorName: posts.authorName,
  sourceName: posts.sourceName,
  sourceUrl: posts.sourceUrl,
  collectedAt: posts.collectedAt,
  cardnews: posts.cardnews,
  formula: posts.formula,
  relatedArticleId: posts.relatedArticleId,
  createdAt: posts.createdAt,
  likeCount: likeCountSql,
  commentCount: commentCountSql,
  viewCount: viewCountSql,
  saveCount: saveCountSql,
};

type PostRow = {
  id: string;
  postType: Post["postType"];
  title: string;
  oneLiner: string | null;
  category: Post["category"];
  tags: string[];
  difficulty: Post["difficulty"];
  workType: string | null;
  verified: boolean;
  authorType: Post["authorType"];
  authorId: string;
  authorName: string;
  sourceName: string | null;
  sourceUrl: string | null;
  collectedAt: Date | null;
  cardnews: Post["cardnews"];
  formula: Post["formula"];
  relatedArticleId: string | null;
  createdAt: Date;
  likeCount: number;
  commentCount: number;
  viewCount: number;
  saveCount: number;
};

/** PostRow(+saveCount) → 계약 Post(+saveCount 부가 필드). */
export type FeedPost = Post & { saveCount: number };

function rowToPost(r: PostRow): FeedPost {
  return {
    id: r.id,
    postType: r.postType,
    title: r.title,
    oneLiner: r.oneLiner,
    category: r.category,
    tags: r.tags ?? [],
    difficulty: r.difficulty,
    workType: r.workType,
    verified: r.verified,
    authorType: r.authorType,
    authorId: r.authorId,
    authorName: r.authorName,
    sourceName: r.sourceName,
    sourceUrl: r.sourceUrl,
    collectedAt: r.collectedAt ? r.collectedAt.toISOString() : null,
    cardnews: r.cardnews,
    formula: r.formula,
    relatedArticleId: r.relatedArticleId ?? null,
    likeCount: Number(r.likeCount ?? 0),
    commentCount: Number(r.commentCount ?? 0),
    viewCount: Number(r.viewCount ?? 0),
    saveCount: Number(r.saveCount ?? 0),
    createdAt: r.createdAt.toISOString(),
  };
}

// =============================================================================
// 1) 홈 / 피드 — Discover
// =============================================================================
export interface FeedResult {
  /** 개인화: 내 직무·관심 카테고리 우선, 비로그인은 인기순으로 폴백 */
  personalized: FeedPost[];
  /** 이번 주(7일 내) 새 공식 */
  thisWeek: FeedPost[];
  /** 인기(저장+좋아요 가중) 공식 */
  popular: FeedPost[];
  /** 큐레이션 카드뉴스 */
  cardnews: FeedPost[];
  /** 모집 중 모임 하이라이트 */
  recruiting: Activity[];
}

/** jobRole(한글) → Category 매핑(개인화 약결합). */
const JOB_TO_CATEGORY: Record<string, Post["category"][]> = {
  개발: ["dev", "ai"],
  디자인: ["design"],
  PM: ["pm", "insight"],
  마케팅: ["marketing"],
  데이터: ["data"],
  기획: ["pm", "insight"],
  "AI/ML": ["ai", "data"],
};

/**
 * 홈 피드. 개인화는 jobRole→category + interests 태그 매칭 가산점.
 * 비로그인(userId 없음)이면 personalized 는 인기순으로 폴백.
 */
export async function getFeed(opts: {
  userId?: string | null;
  jobRole?: string | null;
  interests?: string[];
} = {}): Promise<FeedResult> {
  const { jobRole = null, interests = [] } = opts;

  // 모든 post 한 번에 로드(데모 규모) 후 메모리에서 분류/스코어링.
  const rows = (await db
    .select(postColumns)
    .from(posts)
    .orderBy(desc(posts.createdAt))) as PostRow[];
  const all = rows.map(rowToPost);

  const formulas = all.filter((p) => p.postType === "formula");
  const cardnews = all.filter((p) => p.postType === "cardnews");

  // 인기 점수 = saveCount*2 + likeCount + viewCount*0.1
  const popularityOf = (p: FeedPost) =>
    p.saveCount * 2 + p.likeCount + p.viewCount * 0.1;
  const popular = [...formulas].sort(
    (a, b) => popularityOf(b) - popularityOf(a),
  );

  // 이번 주
  const weekAgo = Date.now() - 7 * 86_400_000;
  const thisWeek = formulas.filter(
    (p) => new Date(p.createdAt).getTime() >= weekAgo,
  );

  // 개인화 스코어링
  const preferredCats = jobRole ? JOB_TO_CATEGORY[jobRole] ?? [] : [];
  const interestSet = new Set(interests.map((s) => s.toLowerCase()));
  const personalScore = (p: FeedPost) => {
    let s = popularityOf(p) * 0.1;
    if (preferredCats.includes(p.category)) s += 10;
    const tagHit = p.tags.some((t) => interestSet.has(t.toLowerCase()));
    if (tagHit) s += 6;
    // 신선도 약가산
    const ageDays = (Date.now() - new Date(p.createdAt).getTime()) / 86_400_000;
    s += Math.max(0, 5 - ageDays * 0.3);
    return s;
  };
  const personalized =
    preferredCats.length || interestSet.size
      ? [...formulas].sort((a, b) => personalScore(b) - personalScore(a))
      : popular;

  const recruiting = await getRecruitingHighlights(3);

  return {
    personalized: personalized.slice(0, 12),
    thisWeek: thisWeek.slice(0, 8),
    popular: popular.slice(0, 8),
    cardnews: cardnews.slice(0, 6),
    recruiting,
  };
}

// =============================================================================
// 1.5) 아티클(Article) — 크롤러 적재 cardnews 피드 / 상세
// =============================================================================
export interface ArticleParams {
  q?: string;
  category?: string; // Category 직접 필터
  sort?: "latest" | "popular";
}

/** 아티클 피드: postType='cardnews' 만, 검색/카테고리/정렬 적용. */
export async function getArticles(
  params: ArticleParams = {},
): Promise<FeedPost[]> {
  const { q, category, sort = "latest" } = params;

  const where = [eq(posts.postType, "cardnews")];

  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    where.push(
      or(
        ilike(posts.title, like),
        ilike(posts.oneLiner, like),
        sql`${posts.tags}::text ilike ${like}`,
      )!,
    );
  }
  if (category) {
    where.push(eq(posts.category, category as Post["category"]));
  }

  const rows = (await db
    .select(postColumns)
    .from(posts)
    .where(and(...where))
    .orderBy(desc(posts.createdAt))) as PostRow[];

  let result = rows.map(rowToPost);

  if (sort === "popular") {
    result.sort(
      (a, b) =>
        b.saveCount * 2 + b.likeCount + b.viewCount * 0.1 -
        (a.saveCount * 2 + a.likeCount + a.viewCount * 0.1),
    );
  }
  // latest 는 이미 createdAt desc

  return result;
}

export interface ArticleDetail {
  post: FeedPost;
  comments: CommentNode[];
  isSaved: boolean;
  isLiked: boolean;
  author: ProfileLite | null;
  /** 이 아티클(post.id)을 참고해 작성된 아카이브(formula) 목록. */
  relatedArchives: FeedPost[];
}

/**
 * 아티클 상세. cardnews post + 댓글/저장/좋아요 + 작성자 + 관련 아카이브.
 * 관련 아카이브 = posts.relatedArticleId = 이 아티클 id 인 formula 들.
 * 대상이 cardnews 가 아니어도(데이터 유연성) post 는 반환한다. 없으면 null.
 */
export async function getArticle(
  id: string,
  viewerId?: string | null,
): Promise<ArticleDetail | null> {
  const base = await getFormula(id, viewerId);
  if (!base) return null;

  const relRows = (await db
    .select(postColumns)
    .from(posts)
    .where(
      and(
        eq(posts.relatedArticleId, id),
        eq(posts.postType, "formula"),
      ),
    )
    .orderBy(desc(posts.createdAt))) as PostRow[];

  return {
    post: base.post,
    comments: base.comments,
    isSaved: base.isSaved,
    isLiked: base.isLiked,
    author: base.author,
    relatedArchives: relRows.map(rowToPost),
  };
}

// =============================================================================
// 2) 공식 아카이브 — 브라우즈 / 검색 / 필터 / 정렬
// =============================================================================
export interface ArchiveParams {
  q?: string;
  jobRole?: string | null; // category 로 매핑
  tool?: string; // formula.tools 매칭
  workType?: string;
  difficulty?: string;
  sort?: "latest" | "popular" | "verified";
}

/** 아카이브 피드: postType='formula' 만, 필터/정렬 적용. */
export async function getArchives(
  params: ArchiveParams = {},
): Promise<FeedPost[]> {
  const { q, jobRole, tool, workType, difficulty, sort = "latest" } = params;

  const where = [eq(posts.postType, "formula")];

  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    where.push(
      or(
        ilike(posts.title, like),
        ilike(posts.oneLiner, like),
        sql`${posts.tags}::text ilike ${like}`,
      )!,
    );
  }
  if (jobRole) {
    const cats = JOB_TO_CATEGORY[jobRole];
    if (cats?.length) where.push(inArray(posts.category, cats));
  }
  if (workType) where.push(eq(posts.workType, workType));
  if (difficulty) where.push(eq(posts.difficulty, difficulty as Post["difficulty"]));

  const rows = (await db
    .select(postColumns)
    .from(posts)
    .where(and(...where))
    .orderBy(desc(posts.createdAt))) as PostRow[];

  let result = rows.map(rowToPost);

  // tool 필터는 formula.tools(jsonb 내부) → 메모리 필터(데모 규모 안전).
  if (tool) {
    const t = tool.toLowerCase();
    result = result.filter((p) =>
      (p.formula?.tools ?? []).some((x) => x.toLowerCase().includes(t)),
    );
  }

  if (sort === "popular") {
    result.sort(
      (a, b) =>
        b.saveCount * 2 + b.viewCount - (a.saveCount * 2 + a.viewCount),
    );
  } else if (sort === "verified") {
    result.sort(
      (a, b) => Number(b.verified) - Number(a.verified) ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }
  // latest 는 이미 createdAt desc

  return result;
}

/** @deprecated 호환용 별칭. 신규 코드는 getArchives 사용. */
export const getArchive = getArchives;

// =============================================================================
// 공식 상세 — Post + 댓글 + 저장여부 + 작성자(신뢰등급)
// =============================================================================
export interface FormulaDetail {
  post: FeedPost;
  comments: CommentNode[];
  isSaved: boolean;
  isLiked: boolean;
  author: ProfileLite | null;
  /** 이 아카이브가 참고한 아티클(cardnews). relatedArticleId 조회. 없으면 null. */
  sourceArticle: FeedPost | null;
  /** '따라하기'로 참고한 원본 공식(출처). forkedFromId 조회. 없으면 null. */
  sourceFormula: { id: string; title: string; authorName: string } | null;
}

/** 작성자 프로필 요약(상세/카드에서 링크용). */
export interface ProfileLite {
  id: string;
  name: string;
  image: string | null;
  role: string;
  jobRole: string | null;
  trustScore: number;
  tier: Tier;
  badgeLabel: string;
}

/**
 * 평면 댓글 목록 → 트리(무제한 중첩 대댓글).
 * 입력이 createdAt 오름차순이면 각 노드의 replies 도 오름차순으로 쌓인다.
 * 부모가 목록에 없는 고아(cascade 로 사실상 없음)는 최상위로 승격해 유실 방지.
 */
function buildCommentTree(flat: Comment[]): CommentNode[] {
  const byId = new Map<string, CommentNode>();
  for (const c of flat) byId.set(c.id, { ...c, replies: [] });
  const roots: CommentNode[] = [];
  for (const c of flat) {
    const node = byId.get(c.id)!;
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    if (parent) parent.replies.push(node);
    else roots.push(node);
  }
  // 최상위는 최신순(새로 단 댓글이 맨 위 → 작성 직후 페이지네이션에 가려지지 않음).
  // 답글은 입력 순서(createdAt 오름차순) 그대로 — 스레드 흐름 보존.
  return roots.reverse();
}

/** 한 글 댓글 fetch 상한(트리화 전). 초과분은 잘림 — 현 규모에선 충분, 초과 시 서버 페이지네이션 필요. */
const COMMENT_FETCH_CAP = 1000;

/** 단일 post 상세. 없으면 null. 댓글은 interactions(type='comment') 기반. */
export async function getFormula(
  id: string,
  viewerId?: string | null,
): Promise<FormulaDetail | null> {
  const rows = (await db
    .select(postColumns)
    .from(posts)
    .where(eq(posts.id, id))
    .limit(1)) as PostRow[];
  if (!rows.length) return null;
  const post = rowToPost(rows[0]);

  // 댓글 + 작성자 정보 조인 (대댓글 parentId 포함). createdAt 오름차순.
  const commentRows = await db
    .select({
      id: interactions.id,
      postId: interactions.postId,
      userId: interactions.userId,
      body: interactions.body,
      parentId: interactions.parentId,
      createdAt: interactions.createdAt,
      authorName: users.name,
      authorImage: users.image,
      authorIsAgent: users.isAgent,
    })
    .from(interactions)
    .innerJoin(users, eq(users.id, interactions.userId))
    .where(
      and(eq(interactions.postId, id), eq(interactions.type, "comment")),
    )
    .orderBy(asc(interactions.createdAt))
    .limit(COMMENT_FETCH_CAP);

  // 댓글 작성자 등급은 각 작성자 stats 로 계산
  const commenterIds = Array.from(new Set(commentRows.map((c) => c.userId)));
  const tierById = await tierMapFor(commenterIds);

  const flatComments: Comment[] = commentRows.map((c) => ({
    id: c.id,
    postId: c.postId,
    userId: c.userId,
    body: c.body ?? "",
    authorName: c.authorName ?? "익명",
    authorImage: c.authorImage,
    authorTier: tierById.get(c.userId) ?? "sprout",
    createdAt: c.createdAt.toISOString(),
    parentId: c.parentId ?? null,
    isAgent: c.authorIsAgent ?? false,
  }));
  const comments = buildCommentTree(flatComments);

  // 저장/좋아요 여부
  let isSaved = false;
  let isLiked = false;
  if (viewerId) {
    const [bm] = await db
      .select({ id: bookmarks.id })
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, viewerId), eq(bookmarks.postId, id)))
      .limit(1);
    isSaved = !!bm;
    const [lk] = await db
      .select({ id: interactions.id })
      .from(interactions)
      .where(
        and(
          eq(interactions.userId, viewerId),
          eq(interactions.postId, id),
          eq(interactions.type, "like"),
        ),
      )
      .limit(1);
    isLiked = !!lk;
  }

  const author = await getProfileLite(post.authorId);

  // 참고한 아티클(백링크). relatedArticleId 가 있으면 단건 조회.
  let sourceArticle: FeedPost | null = null;
  if (post.relatedArticleId) {
    const srcRows = (await db
      .select(postColumns)
      .from(posts)
      .where(eq(posts.id, post.relatedArticleId))
      .limit(1)) as PostRow[];
    if (srcRows.length) sourceArticle = rowToPost(srcRows[0]);
  }

  // 참고한 원본 공식(따라하기 출처). forkedFromId → 단건(제목·작성자).
  let sourceFormula: FormulaDetail["sourceFormula"] = null;
  const [selfRow] = await db
    .select({ forkedFromId: posts.forkedFromId })
    .from(posts)
    .where(eq(posts.id, id))
    .limit(1);
  if (selfRow?.forkedFromId) {
    const [src] = await db
      .select({ id: posts.id, title: posts.title, authorName: posts.authorName })
      .from(posts)
      .where(eq(posts.id, selfRow.forkedFromId))
      .limit(1);
    if (src) sourceFormula = src;
  }

  return { post, comments, isSaved, isLiked, author, sourceArticle, sourceFormula };
}

/**
 * 아카이브 상세 별칭. getFormula 와 동일하지만 라벨('아카이브') 의미를 명확히.
 * 반환에 sourceArticle(참고 아티클 백링크) 포함.
 */
export async function getArchiveDetail(
  id: string,
  viewerId?: string | null,
): Promise<FormulaDetail | null> {
  return getFormula(id, viewerId);
}

/**
 * 작성자의 다른 공식(상세 우측 "작성자의 다른 공식" 위젯).
 * authorId 가 쓴 formula 중 excludeId 를 제외하고 최신순 N.
 */
export async function getAuthorOtherPosts(
  authorId: string,
  excludeId: string,
  limit = 4,
): Promise<FeedPost[]> {
  if (!authorId) return [];
  const rows = (await db
    .select(postColumns)
    .from(posts)
    .where(
      and(
        eq(posts.authorId, authorId),
        eq(posts.postType, "formula"),
        sql`${posts.id} <> ${excludeId}`,
      ),
    )
    .orderBy(desc(posts.createdAt))
    .limit(limit)) as PostRow[];
  return rows.map(rowToPost);
}

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

// ---- 신뢰등급 계산 헬퍼 (유저 id 목록 → tier 맵) ----
/** 주어진 유저들의 ActivityStats 를 SQL 집계해 tier 만 뽑아낸다. */
async function tierMapFor(userIds: string[]): Promise<Map<string, Tier>> {
  const map = new Map<string, Tier>();
  if (!userIds.length) return map;
  const stats = await statsFor(userIds);
  for (const [id, s] of stats) {
    map.set(id, computeTrust(s).tier);
  }
  return map;
}

/** 유저별 ActivityStats(SQL 집계) 맵. visitCountBase/projectCount 는 저장값. */
async function statsFor(userIds: string[]) {
  type StatsRow = {
    visitCount: number; commentCount: number; formulaCount: number;
    likesReceived: number; projectCount: number;
    verifiedFormulaCount: number; articleFormulaCount: number; completedActivityCount: number; appliedActivityCount: number;
    createdActivityCount: number; followingCount: number;
    savesReceived: number; memberSaves: number; followerCount: number;
    commentsReceived: number; onboarded: boolean; hasCompany: boolean;
    externalLinkCount: number;
  };
  const map = new Map<string, StatsRow>();
  if (!userIds.length) return map;

  const urows = await db
    .select({
      id: users.id,
      visitCountBase: users.visitCountBase,
      projectCount: users.projectCount,
      onboarded: users.onboarded,
      company: users.company,
      github: users.github,
      blog: users.blog,
      homepage: users.homepage,
    })
    .from(users)
    .where(inArray(users.id, userIds));

  // 본인이 만든 view 이벤트 수
  const viewRows = await db
    .select({ userId: interactions.userId, c: sql<number>`count(*)::int` })
    .from(interactions)
    .where(and(inArray(interactions.userId, userIds), eq(interactions.type, "view")))
    .groupBy(interactions.userId);
  const viewBy = new Map(viewRows.map((r) => [r.userId, Number(r.c)]));

  // 본인이 쓴 댓글 수
  const cmtRows = await db
    .select({ userId: interactions.userId, c: sql<number>`count(*)::int` })
    .from(interactions)
    .where(and(inArray(interactions.userId, userIds), eq(interactions.type, "comment")))
    .groupBy(interactions.userId);
  const cmtBy = new Map(cmtRows.map((r) => [r.userId, Number(r.c)]));

  // 본인이 쓴 글(formula) 수
  const fmRows = await db
    .select({ authorId: posts.authorId, c: sql<number>`count(*)::int` })
    .from(posts)
    .where(and(inArray(posts.authorId, userIds), eq(posts.postType, "formula")))
    .groupBy(posts.authorId);
  const fmBy = new Map(fmRows.map((r) => [r.authorId, Number(r.c)]));

  // 검증된 공식 수
  const verifiedRows = await db
    .select({ authorId: posts.authorId, c: sql<number>`count(*)::int` })
    .from(posts)
    .where(and(inArray(posts.authorId, userIds), eq(posts.postType, "formula"), eq(posts.verified, true)))
    .groupBy(posts.authorId);
  const verifiedBy = new Map(verifiedRows.map((r) => [r.authorId, Number(r.c)]));

  // 본인 글이 받은 좋아요 수
  const likeRows = await db
    .select({ authorId: posts.authorId, c: sql<number>`count(*)::int` })
    .from(interactions)
    .innerJoin(posts, eq(posts.id, interactions.postId))
    .where(and(inArray(posts.authorId, userIds), eq(interactions.type, "like")))
    .groupBy(posts.authorId);
  const likeBy = new Map(likeRows.map((r) => [r.authorId, Number(r.c)]));

  // 본인 글이 받은 댓글 수
  const crcRows = await db
    .select({ authorId: posts.authorId, c: sql<number>`count(*)::int` })
    .from(interactions)
    .innerJoin(posts, eq(posts.id, interactions.postId))
    .where(and(inArray(posts.authorId, userIds), eq(interactions.type, "comment")))
    .groupBy(posts.authorId);
  const crcBy = new Map(crcRows.map((r) => [r.authorId, Number(r.c)]));

  // 북마크 받은 수 (공식 저장받음)
  const saveRows = await db
    .select({ authorId: posts.authorId, c: sql<number>`count(*)::int` })
    .from(bookmarks)
    .innerJoin(posts, eq(posts.id, bookmarks.postId))
    .where(inArray(posts.authorId, userIds))
    .groupBy(posts.authorId);
  const saveBy = new Map(saveRows.map((r) => [r.authorId, Number(r.c)]));

  // 멤버 저장 수 (하트)
  const mSaveRows = await db
    .select({ memberId: memberBookmarks.memberId, c: sql<number>`count(*)::int` })
    .from(memberBookmarks)
    .where(inArray(memberBookmarks.memberId, userIds))
    .groupBy(memberBookmarks.memberId);
  const mSaveBy = new Map(mSaveRows.map((r) => [r.memberId, Number(r.c)]));

  // 팔로워 수
  const followRows = await db
    .select({ followingId: follows.followingId, c: sql<number>`count(*)::int` })
    .from(follows)
    .where(inArray(follows.followingId, userIds))
    .groupBy(follows.followingId);
  const followBy = new Map(followRows.map((r) => [r.followingId, Number(r.c)]));

  // 완주한 모임 수 (수락된 지원 + activity.status='done')
  const completedRows = await db
    .select({ userId: applications.userId, c: sql<number>`count(*)::int` })
    .from(applications)
    .innerJoin(activities, eq(activities.id, applications.activityId))
    .where(
      and(
        inArray(applications.userId, userIds),
        eq(applications.status, "accepted"),
        eq(activities.status, "done"),
      ),
    )
    .groupBy(applications.userId);
  const completedBy = new Map(completedRows.map((r) => [r.userId, Number(r.c)]));

  // 모임 지원 횟수 (상태 무관)
  const appliedRows = await db
    .select({ userId: applications.userId, c: sql<number>`count(*)::int` })
    .from(applications)
    .where(inArray(applications.userId, userIds))
    .groupBy(applications.userId);
  const appliedBy = new Map(appliedRows.map((r) => [r.userId, Number(r.c)]));

  // 모임 개설 횟수
  const createdRows = await db
    .select({ ownerId: activities.ownerId, c: sql<number>`count(*)::int` })
    .from(activities)
    .where(inArray(activities.ownerId, userIds))
    .groupBy(activities.ownerId);
  const createdBy = new Map(createdRows.map((r) => [r.ownerId, Number(r.c)]));

  // 팔로잉 수
  const followingRows = await db
    .select({ followerId: follows.followerId, c: sql<number>`count(*)::int` })
    .from(follows)
    .where(inArray(follows.followerId, userIds))
    .groupBy(follows.followerId);
  const followingBy = new Map(followingRows.map((r) => [r.followerId, Number(r.c)]));

  // 아티클 참고해 만든 공식 수 (relatedArticleId non-null) — '아티클 변환' 배지 판정용
  const articleFmRows = await db
    .select({ authorId: posts.authorId, c: sql<number>`count(*)::int` })
    .from(posts)
    .where(
      and(
        inArray(posts.authorId, userIds),
        eq(posts.postType, "formula"),
        isNotNull(posts.relatedArticleId),
      ),
    )
    .groupBy(posts.authorId);
  const articleFmBy = new Map(articleFmRows.map((r) => [r.authorId, Number(r.c)]));

  for (const u of urows) {
    const extLinks = [u.github, u.blog, u.homepage].filter(Boolean).length;
    map.set(u.id, {
      visitCount: (u.visitCountBase ?? 0) + (viewBy.get(u.id) ?? 0),
      commentCount: cmtBy.get(u.id) ?? 0,
      formulaCount: fmBy.get(u.id) ?? 0,
      likesReceived: likeBy.get(u.id) ?? 0,
      projectCount: u.projectCount ?? 0,
      verifiedFormulaCount: verifiedBy.get(u.id) ?? 0,
      articleFormulaCount: articleFmBy.get(u.id) ?? 0,
      completedActivityCount: completedBy.get(u.id) ?? 0,
      appliedActivityCount: appliedBy.get(u.id) ?? 0,
      createdActivityCount: createdBy.get(u.id) ?? 0,
      followingCount: followingBy.get(u.id) ?? 0,
      savesReceived: saveBy.get(u.id) ?? 0,
      memberSaves: mSaveBy.get(u.id) ?? 0,
      followerCount: followBy.get(u.id) ?? 0,
      commentsReceived: crcBy.get(u.id) ?? 0,
      onboarded: u.onboarded ?? false,
      hasCompany: !!u.company,
      externalLinkCount: extLinks,
    });
  }
  return map;
}

/** 단일 유저 ProfileLite(신뢰등급 포함). 없으면 null. */
export async function getProfileLite(
  userId: string,
): Promise<ProfileLite | null> {
  const [u] = await db
    .select({
      id: users.id,
      name: users.name,
      image: users.image,
      role: users.role,
      jobRole: users.jobRole,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return null;
  const stats = await statsFor([userId]);
  const t = computeTrust(stats.get(userId) ?? {
    visitCount: 0, commentCount: 0, formulaCount: 0,
    likesReceived: 0, projectCount: 0,
  });
  return {
    id: u.id,
    name: u.name ?? "익명",
    image: u.image,
    role: u.role,
    jobRole: u.jobRole,
    trustScore: t.trustScore,
    tier: t.tier,
    badgeLabel: t.badgeLabel,
  };
}

// =============================================================================
// 3) 멤버 — 디렉토리 / 프로필
// =============================================================================
export interface MemberCard {
  id: string;
  name: string;
  image: string | null;
  role: string;
  company: string | null;
  bio: string;
  jobRole: string | null;
  interests: string[];
  isAgent: boolean;
  trustScore: number;
  tier: Tier;
  badgeLabel: string;
  formulaCount: number;
  followerCount: number;
  /** 이 멤버가 저장(북마크)된 수 (포뮬러 하트 집계) */
  saveCount: number;
  /** 뷰어가 이 멤버를 저장했는지 (뷰어 없으면 false) */
  isBookmarked: boolean;
  /** 뷰어가 이 멤버를 팔로우 중인지 (뷰어 없으면 false) */
  isFollowing: boolean;
}

/** memberId 기준 멤버 저장 수 맵. */
async function memberSaveCountMap(
  memberIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!memberIds.length) return map;
  const rows = await db
    .select({
      memberId: memberBookmarks.memberId,
      c: sql<number>`count(*)::int`,
    })
    .from(memberBookmarks)
    .where(inArray(memberBookmarks.memberId, memberIds))
    .groupBy(memberBookmarks.memberId);
  for (const r of rows) map.set(r.memberId, Number(r.c));
  return map;
}

/** 뷰어가 저장한 멤버 id 집합(대상 memberIds 한정). 뷰어 없으면 빈 집합. */
async function viewerMemberBookmarkSet(
  viewerId: string | null | undefined,
  memberIds: string[],
): Promise<Set<string>> {
  const set = new Set<string>();
  if (!viewerId || !memberIds.length) return set;
  const rows = await db
    .select({ memberId: memberBookmarks.memberId })
    .from(memberBookmarks)
    .where(
      and(
        eq(memberBookmarks.userId, viewerId),
        inArray(memberBookmarks.memberId, memberIds),
      ),
    );
  for (const r of rows) set.add(r.memberId);
  return set;
}

/** 뷰어가 팔로우 중인 멤버 id 집합(주어진 후보 중). 뷰어 없으면 빈 집합. */
async function viewerFollowingSet(
  viewerId: string | null | undefined,
  memberIds: string[],
): Promise<Set<string>> {
  const set = new Set<string>();
  if (!viewerId || !memberIds.length) return set;
  const rows = await db
    .select({ followingId: follows.followingId })
    .from(follows)
    .where(
      and(
        eq(follows.followerId, viewerId),
        inArray(follows.followingId, memberIds),
      ),
    );
  for (const r of rows) set.add(r.followingId);
  return set;
}

/** 뷰어가 특정 멤버를 저장했는지. */
export async function isMemberBookmarked(
  viewerId: string | null | undefined,
  memberId: string,
): Promise<boolean> {
  if (!viewerId || !memberId) return false;
  const [row] = await db
    .select({ id: memberBookmarks.id })
    .from(memberBookmarks)
    .where(
      and(
        eq(memberBookmarks.userId, viewerId),
        eq(memberBookmarks.memberId, memberId),
      ),
    )
    .limit(1);
  return !!row;
}

/** 멤버 디렉토리(검색·직무 필터). agent 는 제외. */
export async function getMemberDirectory(
  opts: { q?: string; jobRole?: string | null; viewerId?: string | null } = {},
): Promise<MemberCard[]> {
  const { q, jobRole, viewerId } = opts;
  const where = [eq(users.isAgent, false), isNull(users.deactivatedAt)];
  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    where.push(
      or(
        ilike(users.name, like),
        ilike(users.role, like),
        ilike(users.bio, like),
        sql`${users.interests}::text ilike ${like}`,
      )!,
    );
  }
  if (jobRole) where.push(eq(users.jobRole, jobRole));

  const urows = await db
    .select()
    .from(users)
    .where(and(...where))
    .orderBy(desc(users.createdAt));

  const ids = urows.map((u) => u.id);
  const stats = await statsFor(ids);
  const followerBy = await followerCountMap(ids);
  const saveBy = await memberSaveCountMap(ids);
  const bookmarkedSet = await viewerMemberBookmarkSet(viewerId, ids);
  const followingSet = await viewerFollowingSet(viewerId, ids);

  return urows.map((u) => {
    const s = stats.get(u.id) ?? {
      visitCount: 0, commentCount: 0, formulaCount: 0,
      likesReceived: 0, projectCount: 0,
    };
    const t = computeTrust(s);
    return {
      id: u.id,
      name: u.name ?? "익명",
      image: u.image,
      role: u.role,
      company: u.company,
      bio: u.bio,
      jobRole: u.jobRole,
      interests: (u.interests as string[]) ?? [],
      isAgent: u.isAgent,
      trustScore: t.trustScore,
      tier: t.tier,
      badgeLabel: t.badgeLabel,
      formulaCount: s.formulaCount,
      followerCount: followerBy.get(u.id) ?? 0,
      saveCount: saveBy.get(u.id) ?? 0,
      isBookmarked: bookmarkedSet.has(u.id),
      isFollowing: followingSet.has(u.id),
    } satisfies MemberCard;
  });
}

/** followingId 기준 팔로워 수 맵. */
async function followerCountMap(userIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!userIds.length) return map;
  const rows = await db
    .select({
      followingId: follows.followingId,
      c: sql<number>`count(*)::int`,
    })
    .from(follows)
    .where(inArray(follows.followingId, userIds))
    .groupBy(follows.followingId);
  for (const r of rows) map.set(r.followingId, Number(r.c));
  return map;
}

/** followerId 기준 팔로잉 수 맵. */
async function followingCountMap(userIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!userIds.length) return map;
  const rows = await db
    .select({
      followerId: follows.followerId,
      c: sql<number>`count(*)::int`,
    })
    .from(follows)
    .where(inArray(follows.followerId, userIds))
    .groupBy(follows.followerId);
  for (const r of rows) map.set(r.followerId, Number(r.c));
  return map;
}

// ---- 멤버 프로필 (자산축적) ----
export interface ProfileResult {
  user: User; // 계약 User (trustScore/tier/badge/activityStats 채움)
  authoredPosts: FeedPost[]; // 내 공식 모음(saveCount 포함)
  followerCount: number;
  followingCount: number;
  isFollowing: boolean; // 뷰어가 이 유저를 팔로우 중인지
  isMe: boolean;
}

/**
 * 프로필. idOrMe === 'me' 면 세션 유저로 해석.
 * 미로그인 + 'me' 이면 null.
 */
export async function getProfile(
  idOrMe: string,
  viewerId?: string | null,
): Promise<ProfileResult | null> {
  const targetId =
    idOrMe === "me" ? viewerId ?? (await currentUserId()) : idOrMe;
  if (!targetId) return null;

  const [u] = (await db
    .select()
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1)) as DbUser[];
  if (!u) return null;

  const stats = await statsFor([targetId]);
  const s = stats.get(targetId) ?? {
    visitCount: 0, commentCount: 0, formulaCount: 0,
    likesReceived: 0, projectCount: 0,
  };
  const t = computeTrust(s);

  // 내 공식 모음(작성한 모든 post)
  const authoredRows = (await db
    .select(postColumns)
    .from(posts)
    .where(eq(posts.authorId, targetId))
    .orderBy(desc(posts.createdAt))) as PostRow[];
  const authoredPosts = authoredRows.map(rowToPost);

  const followerCount = (await followerCountMap([targetId])).get(targetId) ?? 0;
  const followingCount =
    (await followingCountMap([targetId])).get(targetId) ?? 0;

  let isFollowing = false;
  const viewer = viewerId ?? (await currentUserId());
  if (viewer && viewer !== targetId) {
    const [f] = await db
      .select({ id: follows.id })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, viewer),
          eq(follows.followingId, targetId),
        ),
      )
      .limit(1);
    isFollowing = !!f;
  }

  const user: User = {
    id: u.id,
    name: u.name ?? "익명",
    email: u.email,
    image: u.image,
    role: u.role,
    company: u.company,
    bio: u.bio,
    interests: (u.interests as string[]) ?? [],
    github: u.github,
    homepage: u.homepage,
    blog: u.blog,
    jobRole: u.jobRole,
    onboarded: u.onboarded,
    isAgent: u.isAgent,
    authoredPostIds: authoredPosts.map((p) => p.id),
    // ★ s(완전한 StatsRow) 전체를 그대로 전달 — 5필드만 복사하면 MannerTempCard/배지가
    //   절단된 스탯으로 재계산해 서버 trustScore/tier 와 불일치(완주·검증·하트 누락). 전체 전달.
    activityStats: { ...s },
    trustScore: t.trustScore,
    tier: t.tier,
    badgeLabel: t.badgeLabel,
    createdAt: u.createdAt.toISOString(),
  };

  return {
    user,
    authoredPosts,
    followerCount,
    followingCount,
    isFollowing,
    isMe: viewer === targetId,
  };
}

// ---- 활동 이력 타임라인 (공개 이벤트만) ----
/** 프로필 활동 이력 한 건. 내 행동 + 받은 반응을 시간순 통합. */
export interface ActivityEvent {
  kind: string;
  emoji: string;
  text: string;
  at: string; // ISO
  href?: string; // 클릭 시 이동(공식/멤버/모임)
  tempGain?: number; // 온도 원점수 기여값 (있을 때만 표시)
}

/**
 * 유저의 활동 이력을 시간순 통합 반환(최신순 N). 파생 방식(전용 저장 없음).
 * - 공개: 공식 작성 · 댓글 · 모임 지원 · 팔로우 · 받은 좋아요 · 저장받음
 * - 사적(includePrivate=true, 본인만): 누른 좋아요 · 저장한 공식 · 저장한 멤버
 */
export async function getActivityTimeline(
  userId: string,
  opts: { limit?: number; includePrivate?: boolean } = {},
): Promise<ActivityEvent[]> {
  const { limit = 20, includePrivate = false } = opts;
  if (!userId) return [];

  const events: ActivityEvent[] = [];
  const cut = (s: string, n = 40) => (s.length > n ? s.slice(0, n) + "…" : s);

  // 0) 프로필 채우기 — onboarded 시 기본 온도 부여 [공개]
  const [uRow] = await db
    .select({ onboarded: users.onboarded, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (uRow?.onboarded)
    events.push({ kind: "onboarded", emoji: "🌡️", text: "프로필을 채웠어요", at: uRow.createdAt.toISOString(), tempGain: WEIGHTS.onboarded });

  // 1) 작성한 공식 [공개]
  const authored = await db
    .select({ id: posts.id, title: posts.title, createdAt: posts.createdAt })
    .from(posts)
    .where(and(eq(posts.authorId, userId), eq(posts.postType, "formula")))
    .orderBy(desc(posts.createdAt))
    .limit(limit);
  for (const p of authored)
    events.push({ kind: "write", emoji: "📝", text: `공식 '${cut(p.title)}' 작성`, at: p.createdAt.toISOString(), href: `/formula/${p.id}` });

  // 2) 내가 단 댓글 [공개]
  const myComments = await db
    .select({ title: posts.title, postId: posts.id, createdAt: interactions.createdAt })
    .from(interactions)
    .innerJoin(posts, eq(posts.id, interactions.postId))
    .where(and(eq(interactions.userId, userId), eq(interactions.type, "comment")))
    .orderBy(desc(interactions.createdAt))
    .limit(limit);
  for (const c of myComments)
    events.push({ kind: "comment", emoji: "💬", text: `'${cut(c.title)}'에 댓글을 남겼어요`, at: c.createdAt.toISOString(), href: `/formula/${c.postId}` });

  // 3) 모임 지원 [공개]
  const myApps = await db
    .select({ title: activities.title, actId: activities.id, createdAt: applications.createdAt })
    .from(applications)
    .innerJoin(activities, eq(activities.id, applications.activityId))
    .where(eq(applications.userId, userId))
    .orderBy(desc(applications.createdAt))
    .limit(limit);
  for (const a of myApps)
    events.push({ kind: "apply", emoji: "🚀", text: `'${cut(a.title)}' 모임에 지원했어요`, at: a.createdAt.toISOString(), href: `/activities/${a.actId}` });

  // 4) 팔로우 [공개]
  const myFollows = await db
    .select({ id: users.id, name: users.name, createdAt: follows.createdAt })
    .from(follows)
    .innerJoin(users, eq(users.id, follows.followingId))
    .where(eq(follows.followerId, userId))
    .orderBy(desc(follows.createdAt))
    .limit(limit);
  for (const f of myFollows)
    events.push({ kind: "follow", emoji: "➕", text: `${f.name ?? "익명"}님을 팔로우했어요`, at: f.createdAt.toISOString(), href: `/profile/${f.id}` });

  // 5) 내 글이 받은 좋아요 [공개·신뢰]
  const likesRecv = await db
    .select({ title: posts.title, postId: posts.id, createdAt: interactions.createdAt })
    .from(interactions)
    .innerJoin(posts, eq(posts.id, interactions.postId))
    .where(and(eq(posts.authorId, userId), eq(interactions.type, "like")))
    .orderBy(desc(interactions.createdAt))
    .limit(limit);
  for (const l of likesRecv)
    events.push({ kind: "like-recv", emoji: "❤️", text: `'${cut(l.title)}'이 좋아요를 받았어요`, at: l.createdAt.toISOString(), href: `/formula/${l.postId}` });

  // 6) 내 글이 저장받음 [공개·신뢰]
  const savesRecv = await db
    .select({ title: posts.title, postId: posts.id, createdAt: bookmarks.createdAt })
    .from(bookmarks)
    .innerJoin(posts, eq(posts.id, bookmarks.postId))
    .where(eq(posts.authorId, userId))
    .orderBy(desc(bookmarks.createdAt))
    .limit(limit);
  for (const s of savesRecv)
    events.push({ kind: "save-recv", emoji: "🔖", text: `'${cut(s.title)}'이 저장됐어요`, at: s.createdAt.toISOString(), href: `/formula/${s.postId}`, tempGain: WEIGHTS.saveReceived });

  // 6-2) 검증된 공식 [공개·신뢰 — verifiedAt 없어 createdAt 근사]
  const verifiedPosts = await db
    .select({ id: posts.id, title: posts.title, createdAt: posts.createdAt })
    .from(posts)
    .where(and(eq(posts.authorId, userId), eq(posts.postType, "formula"), eq(posts.verified, true)))
    .orderBy(desc(posts.createdAt))
    .limit(limit);
  for (const p of verifiedPosts)
    events.push({ kind: "verified", emoji: "✅", text: `'${cut(p.title)}' 공식이 검증됐어요`, at: p.createdAt.toISOString(), href: `/formula/${p.id}`, tempGain: WEIGHTS.verifiedFormula });

  // 7~9) 사적 행동 — 본인 마이페이지에서만
  if (includePrivate) {
    // 7) 내가 누른 좋아요
    const myLikes = await db
      .select({ title: posts.title, postId: posts.id, createdAt: interactions.createdAt })
      .from(interactions)
      .innerJoin(posts, eq(posts.id, interactions.postId))
      .where(and(eq(interactions.userId, userId), eq(interactions.type, "like")))
      .orderBy(desc(interactions.createdAt))
      .limit(limit);
    for (const l of myLikes)
      events.push({ kind: "like", emoji: "👍", text: `'${cut(l.title)}'에 좋아요를 눌렀어요`, at: l.createdAt.toISOString(), href: `/formula/${l.postId}` });

    // 8) 내가 저장한 공식
    const myBookmarks = await db
      .select({ title: posts.title, postId: posts.id, createdAt: bookmarks.createdAt })
      .from(bookmarks)
      .innerJoin(posts, eq(posts.id, bookmarks.postId))
      .where(eq(bookmarks.userId, userId))
      .orderBy(desc(bookmarks.createdAt))
      .limit(limit);
    for (const b of myBookmarks)
      events.push({ kind: "bookmark", emoji: "🔖", text: `'${cut(b.title)}'을 저장했어요`, at: b.createdAt.toISOString(), href: `/formula/${b.postId}` });

    // 9) 내가 저장한 멤버(하트)
    const myMemberSaves = await db
      .select({ id: users.id, name: users.name, createdAt: memberBookmarks.createdAt })
      .from(memberBookmarks)
      .innerJoin(users, eq(users.id, memberBookmarks.memberId))
      .where(eq(memberBookmarks.userId, userId))
      .orderBy(desc(memberBookmarks.createdAt))
      .limit(limit);
    for (const m of myMemberSaves)
      events.push({ kind: "member-save", emoji: "💜", text: `${m.name ?? "익명"}님을 저장했어요`, at: m.createdAt.toISOString(), href: `/profile/${m.id}` });
  }

  return events
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);
}

// ---- 지원한 모임/스터디 (마이페이지) ----
/** 내가 지원한 모임 한 건 — 모임 + 내 지원 상태. */
export interface AppliedActivity {
  activity: Activity;
  status: Application["status"];
  appliedAt: string;
}

/** userId 가 지원한 모임 목록(지원 최근순) + 각 지원 상태. */
export async function getAppliedActivities(
  userId: string,
): Promise<AppliedActivity[]> {
  if (!userId) return [];
  const rows = await db
    .select({
      id: activities.id,
      type: activities.type,
      title: activities.title,
      summary: activities.summary,
      description: activities.description,
      status: activities.status,
      ownerId: activities.ownerId,
      ownerName: activities.ownerName,
      tags: activities.tags,
      capacity: activities.capacity,
      season: activities.season,
      createdAt: activities.createdAt,
      applicantCount: applicantCountSql,
      appStatus: applications.status,
      appliedAt: applications.createdAt,
    })
    .from(applications)
    .innerJoin(activities, eq(activities.id, applications.activityId))
    .where(eq(applications.userId, userId))
    .orderBy(desc(applications.createdAt));

  return rows.map((r) => ({
    activity: rowToActivity(r as Parameters<typeof rowToActivity>[0]),
    status: r.appStatus,
    appliedAt: r.appliedAt.toISOString(),
  }));
}

// =============================================================================
// 내 저장함
// =============================================================================
/** userId 의 저장한 공식(최근 저장순). */
export async function getSaved(userId: string): Promise<FeedPost[]> {
  if (!userId) return [];
  const rows = (await db
    .select({ ...postColumns, savedAt: bookmarks.createdAt })
    .from(bookmarks)
    .innerJoin(posts, eq(posts.id, bookmarks.postId))
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt))) as (PostRow & { savedAt: Date })[];
  return rows.map(rowToPost);
}

/** 북마크한 글의 해시태그 빈도 상위 N개. */
export async function getTopBookmarkTags(
  userId: string,
  limit = 5,
): Promise<{ tag: string; count: number }[]> {
  if (!userId) return [];
  const rows = await db.execute(sql`
    SELECT tag, count(*)::int AS cnt
    FROM bookmark b
    JOIN post p ON p.id = b."postId"
    CROSS JOIN LATERAL jsonb_array_elements_text(p.tags) AS tag
    WHERE b."userId" = ${userId}
    GROUP BY tag
    ORDER BY cnt DESC
    LIMIT ${limit}
  `);
  return (rows.rows as { tag: string; cnt: number }[]).map((r) => ({
    tag: r.tag,
    count: Number(r.cnt),
  }));
}

// =============================================================================
// 4) 모임 — 목록 / 상세
// =============================================================================
const applicantCountSql = sql<number>`(
  select count(*)::int from ${applications} a
  where a."activityId" = ${activities.id}
)`;

function rowToActivity(r: {
  id: string;
  type: Activity["type"];
  title: string;
  summary: string;
  description: string;
  status: Activity["status"];
  ownerId: string;
  ownerName: string;
  tags: string[];
  capacity: number;
  season: string | null;
  createdAt: Date;
  applicantCount: number;
}): Activity {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    summary: r.summary,
    description: r.description,
    status: r.status,
    ownerId: r.ownerId,
    ownerName: r.ownerName,
    tags: r.tags ?? [],
    capacity: r.capacity,
    season: r.season,
    createdAt: r.createdAt.toISOString(),
    applicantCount: Number(r.applicantCount ?? 0),
  };
}

/** 모임 목록(타입·상태 필터). applicantCount SQL 집계. */
export async function getActivities(
  opts: { type?: Activity["type"]; status?: Activity["status"] } = {},
): Promise<Activity[]> {
  const { type, status } = opts;
  const where = [];
  if (type) where.push(eq(activities.type, type));
  if (status) where.push(eq(activities.status, status));

  const rows = await db
    .select({
      id: activities.id,
      type: activities.type,
      title: activities.title,
      summary: activities.summary,
      description: activities.description,
      status: activities.status,
      ownerId: activities.ownerId,
      ownerName: activities.ownerName,
      tags: activities.tags,
      capacity: activities.capacity,
      season: activities.season,
      createdAt: activities.createdAt,
      applicantCount: applicantCountSql,
    })
    .from(activities)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(activities.createdAt));

  return rows.map((r) => rowToActivity(r as Parameters<typeof rowToActivity>[0]));
}

export interface ActivityDetail {
  activity: Activity;
  applicants: Application[];
  myApplication: Application | null; // 뷰어의 지원(없으면 null)
}

/** 모임 상세 + 지원자 목록 + 내 지원 여부. */
export async function getActivity(
  id: string,
  viewerId?: string | null,
): Promise<ActivityDetail | null> {
  const rows = await db
    .select({
      id: activities.id,
      type: activities.type,
      title: activities.title,
      summary: activities.summary,
      description: activities.description,
      status: activities.status,
      ownerId: activities.ownerId,
      ownerName: activities.ownerName,
      tags: activities.tags,
      capacity: activities.capacity,
      season: activities.season,
      createdAt: activities.createdAt,
      applicantCount: applicantCountSql,
    })
    .from(activities)
    .where(eq(activities.id, id))
    .limit(1);
  if (!rows.length) return null;
  const activity = rowToActivity(
    rows[0] as Parameters<typeof rowToActivity>[0],
  );

  const appRows = await db
    .select()
    .from(applications)
    .where(eq(applications.activityId, id))
    .orderBy(desc(applications.createdAt));

  const applicants: Application[] = appRows.map((a) => ({
    id: a.id,
    activityId: a.activityId,
    userId: a.userId,
    userName: a.userName,
    message: a.message,
    status: a.status,
    createdAt: a.createdAt.toISOString(),
  }));

  const myApplication = viewerId
    ? applicants.find((a) => a.userId === viewerId) ?? null
    : null;

  return { activity, applicants, myApplication };
}

/** 모집 중 모임 하이라이트(최근순 N). */
export async function getRecruitingHighlights(
  limit = 3,
): Promise<Activity[]> {
  const rows = await db
    .select({
      id: activities.id,
      type: activities.type,
      title: activities.title,
      summary: activities.summary,
      description: activities.description,
      status: activities.status,
      ownerId: activities.ownerId,
      ownerName: activities.ownerName,
      tags: activities.tags,
      capacity: activities.capacity,
      season: activities.season,
      createdAt: activities.createdAt,
      applicantCount: applicantCountSql,
    })
    .from(activities)
    .where(eq(activities.status, "recruiting"))
    .orderBy(desc(activities.createdAt))
    .limit(limit);
  return rows.map((r) => rowToActivity(r as Parameters<typeof rowToActivity>[0]));
}

/**
 * 모집 중 모임 N개. getRecruitingHighlights 의 의미 명확 별칭(홈 사이드 위젯용).
 */
export async function getRecruitingActivities(
  limit = 3,
): Promise<Activity[]> {
  return getRecruitingHighlights(limit);
}

// =============================================================================
// 홈 위젯 — 인기 TOP5 / 추천 포뮬러
// =============================================================================
/**
 * 인기 글 TOP5. 기본은 아티클(cardnews) 우선, 부족하면 아카이브(formula)로 채워
 * 항상 최대 5개를 인기순(저장*2 + 좋아요 + 조회*0.1)으로 반환한다.
 * onlyArticles=true 면 아티클만 대상으로 한다.
 */
export async function getPopularTop5(
  opts: { onlyArticles?: boolean } = {},
): Promise<FeedPost[]> {
  const { onlyArticles = false } = opts;
  const rows = (await db
    .select(postColumns)
    .from(posts)) as PostRow[];
  const all = rows.map(rowToPost);
  const score = (p: FeedPost) =>
    p.saveCount * 2 + p.likeCount + p.viewCount * 0.1;

  const articles = all
    .filter((p) => p.postType === "cardnews")
    .sort((a, b) => score(b) - score(a));
  if (onlyArticles) return articles.slice(0, 5);

  if (articles.length >= 5) return articles.slice(0, 5);
  const archives = all
    .filter((p) => p.postType === "formula")
    .sort((a, b) => score(b) - score(a));
  return [...articles, ...archives].slice(0, 5);
}

/**
 * 추천 포뮬러(멤버). 신뢰등급(trustScore) 우선, 동률이면 팔로워순.
 * agent 제외. 기본 6명.
 */
export async function getRecommendedFormulers(
  n = 6,
): Promise<MemberCard[]> {
  const members = await getMemberDirectory();
  return [...members]
    .sort(
      (a, b) =>
        b.trustScore - a.trustScore ||
        b.followerCount - a.followerCount ||
        b.formulaCount - a.formulaCount,
    )
    .slice(0, n);
}

// =============================================================================
// 큐레이션 카드뉴스(홈/큐레이션 영역)
// =============================================================================
/** AI 큐레이터 카드뉴스 최신순 N. */
export async function getCurationCardnews(limit = 6): Promise<FeedPost[]> {
  const rows = (await db
    .select(postColumns)
    .from(posts)
    .where(eq(posts.postType, "cardnews"))
    .orderBy(desc(posts.createdAt))
    .limit(limit)) as PostRow[];
  return rows.map(rowToPost);
}

// =============================================================================
// 전역 통합검색
// =============================================================================
export interface SearchResult {
  posts: FeedPost[];
  members: MemberCard[];
  activities: Activity[];
}

/** posts(제목/요약/태그) + members(이름/직무/소개) + activities(제목/요약/태그) 검색. */
export async function searchAll(q: string): Promise<SearchResult> {
  const term = (q ?? "").trim();
  if (!term) return { posts: [], members: [], activities: [] };
  const like = `%${term}%`;

  const postRows = (await db
    .select(postColumns)
    .from(posts)
    .where(
      or(
        ilike(posts.title, like),
        ilike(posts.oneLiner, like),
        sql`${posts.tags}::text ilike ${like}`,
      ),
    )
    .orderBy(desc(posts.createdAt))
    .limit(20)) as PostRow[];

  const members = await getMemberDirectory({ q: term });

  const actRows = await db
    .select({
      id: activities.id,
      type: activities.type,
      title: activities.title,
      summary: activities.summary,
      description: activities.description,
      status: activities.status,
      ownerId: activities.ownerId,
      ownerName: activities.ownerName,
      tags: activities.tags,
      capacity: activities.capacity,
      season: activities.season,
      createdAt: activities.createdAt,
      applicantCount: applicantCountSql,
    })
    .from(activities)
    .where(
      or(
        ilike(activities.title, like),
        ilike(activities.summary, like),
        sql`${activities.tags}::text ilike ${like}`,
      ),
    )
    .orderBy(desc(activities.createdAt))
    .limit(20);

  return {
    posts: postRows.map(rowToPost),
    members,
    activities: actRows.map((r) =>
      rowToActivity(r as Parameters<typeof rowToActivity>[0]),
    ),
  };
}

// =============================================================================
// 5) 채팅 / 1:1 DM — 받은함(inbox) / 대화
// =============================================================================
/** 정규화 페어 정렬: 항상 작은 id 가 user1. */
export function normalizePair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * 두 사용자 간 1:1 대화를 가져오거나 없으면 생성해 conversationId 를 반환.
 * 렌더-세이프(revalidatePath 없음) — 서버 컴포넌트 렌더 중에도 안전하게 호출 가능.
 * 뮤테이션 후 캐시 무효화가 필요하면 호출측(서버 액션)에서 revalidatePath 하세요.
 * race: UNIQUE(user1Id,user2Id) + onConflictDoNothing → 충돌 시 재조회.
 */
export async function findOrCreateConversation(
  userId: string,
  targetUserId: string,
): Promise<
  { ok: true; conversationId: string } | { ok: false; error: string }
> {
  if (!userId) return { ok: false, error: "로그인이 필요해요." };
  if (!targetUserId || typeof targetUserId !== "string") {
    return { ok: false, error: "잘못된 요청이에요." };
  }
  if (targetUserId === userId) {
    return { ok: false, error: "자기 자신과는 대화할 수 없어요." };
  }

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!target) return { ok: false, error: "멤버를 찾을 수 없어요." };

  const [user1Id, user2Id] = normalizePair(userId, targetUserId);

  const findExisting = async () => {
    const [existing] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.user1Id, user1Id),
          eq(conversations.user2Id, user2Id),
        ),
      )
      .limit(1);
    return existing?.id;
  };

  const existingId = await findExisting();
  if (existingId) return { ok: true, conversationId: existingId };

  const [row] = await db
    .insert(conversations)
    .values({ user1Id, user2Id })
    .onConflictDoNothing({
      target: [conversations.user1Id, conversations.user2Id],
    })
    .returning({ id: conversations.id });

  if (row) return { ok: true, conversationId: row.id };

  // 동시 삽입으로 충돌 → 이미 존재하므로 재조회.
  const raced = await findExisting();
  if (raced) return { ok: true, conversationId: raced };
  return { ok: false, error: "대화를 시작하지 못했어요." };
}

/**
 * 받은함. userId 가 속한 모든 대화를 lastMessageAt 내림차순으로,
 * 상대(partner) + 마지막 메시지 + 미읽음수(내가 수신자이고 readAt null)와 함께 반환.
 */
export async function getConversations(
  userId: string,
): Promise<ConversationSummary[]> {
  if (!userId) return [];

  const convRows = await db
    .select({
      id: conversations.id,
      user1Id: conversations.user1Id,
      user2Id: conversations.user2Id,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(conversations)
    .where(
      or(
        eq(conversations.user1Id, userId),
        eq(conversations.user2Id, userId),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt));

  if (!convRows.length) return [];

  const convIds = convRows.map((c) => c.id);
  const partnerIds = Array.from(
    new Set(
      convRows.map((c) => (c.user1Id === userId ? c.user2Id : c.user1Id)),
    ),
  );

  // 상대 프로필(간단)
  const partnerRows = await db
    .select({
      id: users.id,
      name: users.name,
      image: users.image,
      role: users.role,
    })
    .from(users)
    .where(inArray(users.id, partnerIds));
  const partnerById = new Map(partnerRows.map((p) => [p.id, p]));

  // 대화별 마지막 메시지(메모리에서 최신 1건 선별 — 데모 규모 안전)
  const msgRows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      senderId: messages.senderId,
      body: messages.body,
      readAt: messages.readAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(inArray(messages.conversationId, convIds))
    .orderBy(desc(messages.createdAt));

  const lastByConv = new Map<string, (typeof msgRows)[number]>();
  const unreadByConv = new Map<string, number>();
  for (const m of msgRows) {
    if (!lastByConv.has(m.conversationId)) {
      lastByConv.set(m.conversationId, m);
    }
    // 미읽음 = 내가 수신자(상대가 보냄) + readAt null
    if (m.senderId !== userId && m.readAt === null) {
      unreadByConv.set(
        m.conversationId,
        (unreadByConv.get(m.conversationId) ?? 0) + 1,
      );
    }
  }

  return convRows.map((c) => {
    const partnerId = c.user1Id === userId ? c.user2Id : c.user1Id;
    const p = partnerById.get(partnerId);
    const last = lastByConv.get(c.id);
    return {
      id: c.id,
      partner: {
        id: partnerId,
        name: p?.name ?? "익명",
        image: p?.image ?? null,
        role: p?.role ?? "",
      },
      lastMessageBody: last?.body ?? null,
      lastMessageAt: (last?.createdAt ?? c.lastMessageAt).toISOString(),
      unreadCount: unreadByConv.get(c.id) ?? 0,
    } satisfies ConversationSummary;
  });
}

export interface ConversationThread {
  conversation: {
    id: string;
    partner: { id: string; name: string; image: string | null; role: string };
  };
  messages: Message[];
}

/**
 * 단일 대화 메시지 목록(권한 확인). userId 가 대화 참여자가 아니면 null.
 * createdAt 오름차순(말풍선 순서). 권한 확인이 핵심 — 액션 markRead 와 함께 사용.
 */
export async function getMessages(
  conversationId: string,
  userId: string,
): Promise<ConversationThread | null> {
  if (!conversationId || !userId) return null;

  const [conv] = await db
    .select({
      id: conversations.id,
      user1Id: conversations.user1Id,
      user2Id: conversations.user2Id,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) return null;
  // 권한 확인: 참여자만 열람 가능
  if (conv.user1Id !== userId && conv.user2Id !== userId) return null;

  const partnerId = conv.user1Id === userId ? conv.user2Id : conv.user1Id;
  const [p] = await db
    .select({
      id: users.id,
      name: users.name,
      image: users.image,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, partnerId))
    .limit(1);

  const msgRows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      senderId: messages.senderId,
      body: messages.body,
      readAt: messages.readAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));

  return {
    conversation: {
      id: conv.id,
      partner: {
        id: partnerId,
        name: p?.name ?? "익명",
        image: p?.image ?? null,
        role: p?.role ?? "",
      },
    },
    messages: msgRows.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      body: m.body,
      readAt: m.readAt ? m.readAt.toISOString() : null,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

/** 받은함 전체 미읽음 메시지 수(헤더 뱃지용). */
export async function getUnreadMessageCount(userId: string): Promise<number> {
  if (!userId) return 0;
  const convRows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      or(
        eq(conversations.user1Id, userId),
        eq(conversations.user2Id, userId),
      ),
    );
  if (!convRows.length) return 0;
  const convIds = convRows.map((c) => c.id);
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        inArray(messages.conversationId, convIds),
        sql`${messages.senderId} <> ${userId}`,
        sql`${messages.readAt} is null`,
      ),
    );
  return Number(row?.c ?? 0);
}

// re-export 편의 타입
export type { DbPost, DbUser };
