"use client";

// 해시태그 기반 관련 글 추천 섹션의 노출/클릭을 GA4 커스텀 이벤트로 트래킹
import { useEffect, useRef } from "react";
import Link from "next/link";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

export type RelatedRecommendationItem = { id: string; title: string };

export type RelatedRecommendationsProps = {
  /** 현재 보고 있는 아티클 id (추천의 출처) */
  articleId: string;
  items: RelatedRecommendationItem[];
};

/**
 * "🔗이런 글은 어떠세요?" 섹션. 화면에 마운트되면 recommendation_shown을,
 * 추천 글을 클릭하면 recommendation_click을 GA4로 전송한다.
 * (da_agent의 recommendation_mart가 이 두 이벤트를 집계하는 전제 — 이벤트명/
 * 파라미터명이 build_marts.py의 recommendation_mart 정의와 반드시 일치해야 함)
 */
export function RelatedRecommendations({
  articleId,
  items,
}: RelatedRecommendationsProps) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || items.length === 0) return;
    fired.current = true;
    window.gtag?.("event", "recommendation_shown", {
      article_id: articleId,
      recommended_ids: items.map((a) => a.id).join(","),
    });
  }, [articleId, items]);

  if (items.length === 0) return null;

  return (
    <section className="linked-formulas" style={{ marginTop: 28 }}>
      <div className="lf-head">
        <span aria-hidden>🔗</span>이런 글은 어떠세요?
      </div>
      <ul className="lf-list">
        {items.map((a) => (
          <li key={a.id}>
            <Link
              href={`/article/${a.id}`}
              className="lf-item"
              onClick={() =>
                window.gtag?.("event", "recommendation_click", {
                  source_article_id: articleId,
                  clicked_article_id: a.id,
                })
              }
            >
              <div className="lf-main">
                <span className="lf-name">{a.title}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
