import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Avatar, ViewTracker, Markdown } from "@/components/ui";
import { AuthorActions } from "./author-actions";
import {
  getArticle,
  getAuthorOtherPosts,
  getRelatedArticles,
  getProfile,
  currentUserId,
} from "@/lib/queries";
import { fmtCount } from "@/lib/ref-style";
import { ogImage, SITE_NAME } from "@/lib/site";
import { ArticleActions } from "./article-actions";
import { DetailComments } from "./detail-comments";
import { RelatedRecommendations } from "./related-recommendations";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const detail = await getArticle(id);
  if (!detail) {
    return { title: "아티클을 찾을 수 없어요 · The Formula" };
  }
  const { post } = detail;
  const title = `${post.title} · The Formula`;
  const description = (
    post.cardnews?.summary ??
    post.oneLiner ??
    "AI 큐레이터가 정리한 아티클"
  ).slice(0, 200);
  const url = `/article/${post.id}`;
  const image = ogImage(post.cardnews?.coverImageUrl);
  const published = post.collectedAt ?? post.createdAt ?? undefined;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      title: post.title,
      description,
      url,
      siteName: SITE_NAME,
      locale: "ko_KR",
      images: [{ url: image, alt: post.title }],
      ...(published ? { publishedTime: published } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description,
      images: [image],
    },
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}. ${m}. ${day}`;
  } catch {
    return "";
  }
}

export default async function ArticleDetailPage({ params }: PageProps) {
  const { id } = await params;
  const viewerId = await currentUserId();
  const detail = await getArticle(id, viewerId);
  if (!detail) notFound();

  const { post, comments, isSaved, isLiked, author, relatedArchives } = detail;

  // 우측 사이드바: 작성자의 다른 공식 + 팔로우 상태
  const otherPosts = author
    ? await getAuthorOtherPosts(author.id, post.id, 4)
    : [];

  // 본문: 해시태그 겹침 기반 관련 아티클 추천 (최대 2개)
  const relatedArticles =
    post.tags.length > 0 ? await getRelatedArticles(post.id, post.tags, 2) : [];
  let isFollowing = false;
  let isMe = false;
  if (author) {
    const prof = await getProfile(author.id, viewerId);
    isFollowing = prof?.isFollowing ?? false;
    isMe = prof?.isMe ?? false;
  }

  const shareUrl = `/article/${post.id}`;
  const dateStr = formatDate(post.collectedAt ?? post.createdAt);

  return (
    <div className="wrap">
      {/* 진입 시 조회수 +1 */}
      <ViewTracker postId={post.id} />

      {/* 뒤로가기 */}
      <Link href="/" className="back">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
        아티클
      </Link>

      <div className="detail-wrap">
        <article className="detail-main">
          {/* 상단 액션 (sticky) */}
          <ArticleActions
            postId={post.id}
            initialSaved={isSaved}
            initialSaveCount={post.saveCount}
            initialLiked={isLiked}
            initialLikeCount={post.likeCount}
            shareUrl={shareUrl}
            loggedIn={!!viewerId}
          />

          {/* 해시태그 */}
          {post.tags.length > 0 && (
            <div className="d-hashtags">
              {post.tags.map((t) => (
                <span key={t}>#{t}</span>
              ))}
            </div>
          )}

          {/* 제목 */}
          <h1 className="d-title">{post.title}</h1>

          {/* 메타: 날짜 · 조회수 */}
          <div className="d-meta">
            {dateStr}
            <span className="d-dot">·</span>
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {fmtCount(post.viewCount)}
          </div>

          {/* 리드(한줄요약) */}
          {post.oneLiner && <p className="d-lead">{post.oneLiner}</p>}

          {/* 원문 대표 이미지(있으면) */}
          {post.cardnews?.coverImageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={post.cardnews.coverImageUrl}
              alt=""
              className="d-cover"
              loading="lazy"
              decoding="async"
            />
          )}

          {/* 본문: 카드뉴스 요약 → 본문 */}
          {post.cardnews ? (
            <>
              <blockquote className="d-quote">
                {post.cardnews.summary}
              </blockquote>

              {post.cardnews.body && (
                <div className="d-block">
                  <div className="lab">정리</div>
                  <Markdown content={post.cardnews.body} />
                </div>
              )}

              {post.sourceUrl && (
                <div className="d-block">
                  <a
                    href={post.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: "var(--blue)",
                    }}
                  >
                    원문 보기
                    {post.sourceName ? ` · ${post.sourceName}` : ""} →
                  </a>
                </div>
              )}
            </>
          ) : (
            <div className="d-block">
              <p style={{ color: "var(--t3)" }}>본문이 아직 준비 중이에요.</p>
            </div>
          )}

          {/* 키워드 태그 */}
          {post.cardnews && post.cardnews.keywords.length > 0 && (
            <div className="d-tags" style={{ marginTop: 28 }}>
              {post.cardnews.keywords.map((k) => (
                <span key={k} className="chip">
                  {k}
                </span>
              ))}
            </div>
          )}

          {/* 관련 글 추천 — 해시태그 겹침 랭킹, 겹치는 글 없으면 섹션 자체 숨김
              (노출/클릭 GA4 트래킹은 related-recommendations.tsx 참고) */}
          <RelatedRecommendations articleId={post.id} items={relatedArticles} />

          {/* =====================================================================
              이 아티클로 만든 공식(아카이브) 연결 섹션 + 큰 CTA
              relatedArchives = posts.relatedArticleId === 이 아티클 인 formula 들.
              ===================================================================== */}
          <section className="linked-formulas">
            <div className="lf-head">
              <span aria-hidden>💡</span>이 아티클로 만든 나만의 공식{" "}
              <b>{relatedArchives.length}개</b>
            </div>

            {relatedArchives.length > 0 ? (
              <ul className="lf-list">
                {relatedArchives.map((f) => (
                  <li key={f.id}>
                    <Link href={`/formula/${f.id}`} className="lf-item">
                      <Avatar
                        id={f.authorId}
                        name={f.authorName}
                        variant="md"
                      />
                      <div className="lf-main">
                        <span className="lf-name">{f.authorName}</span>
                        <span className="lf-desc">{f.oneLiner || f.title}</span>
                      </div>
                      <span className="lf-like">
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          aria-hidden
                        >
                          <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z" />
                        </svg>
                        {fmtCount(f.likeCount)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="lf-empty">
                아직 이 아티클로 만든 공식이 없어요. 첫 번째 공식을 남겨보세요!
              </p>
            )}

            <Link
              href={`/archive/new?articleId=${post.id}`}
              className="lf-cta"
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
              나도 공식 만들기
            </Link>
          </section>

          {/* 댓글 */}
          <DetailComments
            postId={post.id}
            comments={comments}
            loggedIn={!!viewerId}
            viewerId={viewerId}
          />
        </article>

        {/* 우측 사이드바 */}
        {author && (
          <aside className="d-side">
            <div className="author-card">
              <div className="ac-top">
                <Avatar
                  id={author.id}
                  name={author.name}
                  src={author.image}
                  variant="ac"
                />
                <div>
                  <div className="ac-name">{author.name}</div>
                  <div className="ac-role">
                    {author.jobRole ?? author.role}
                  </div>
                </div>
              </div>
              <Link className="ac-link" href={`/profile/${author.id}`}>
                프로필 보기 →
              </Link>
              {!isMe &&
                (viewerId ? (
                  <AuthorActions
                    authorId={author.id}
                    authorName={author.name}
                    initialFollowing={isFollowing}
                  />
                ) : (
                  <div className="ac-actions">
                    <a href="/account" className="ac-follow">
                      로그인하고 팔로우
                    </a>
                  </div>
                ))}
            </div>

            {otherPosts.length > 0 && (
              <div className="author-more">
                <div className="am-head">
                  <span>{author.name}님이 쓴 다른 공식</span>
                  <Link href={`/profile/${author.id}`}>더보기</Link>
                </div>
                {otherPosts.map((p) => (
                  <Link
                    key={p.id}
                    href={`/formula/${p.id}`}
                    className="am-item"
                    style={{ display: "block" }}
                  >
                    {p.title}
                  </Link>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
