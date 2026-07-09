// =============================================================================
// 카드뉴스 생성 — AI SDK v6 generateObject + OpenAI (gpt-4o-mini)
// =============================================================================
// - 텍스트(summary/keywords/body/category)만 AI 생성. 커버 이미지는 생성하지 않음
//   (coverImageUrl = "" → UI 가 결정론적 브랜드 그라데이션으로 렌더).
// - @ai-sdk/openai 가 OPENAI_API_KEY 로 직접 인증(게이트웨이 불필요).
// - 호출 실패 시 결정론적 폴백으로 graceful degrade.
// =============================================================================
import { generateObject, generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type { CardNews, Category } from "@/lib/contract";
import { CATEGORIES, categories, AGENT_PERSONAS } from "@/lib/contract";
import { getSourceKind } from "@/lib/sources";

/** 기본 모델 — GPT-4o mini. 환경변수 CARDNEWS_MODEL 로 오버라이드 가능. */
const CARDNEWS_MODEL = process.env.CARDNEWS_MODEL ?? "gpt-4o-mini";

// AI 가 채울 텍스트 + 분류 스키마 (coverImageUrl 제외)
const cardNewsTextSchema = z.object({
  summary: z
    .string()
    .min(20)
    .max(400)
    .describe("2~3문장 한국어 요약(피드 카드용 티저). 해요체. 핵심 인사이트 위주."),
  keywords: z
    .array(z.string().min(1).max(20))
    .min(3)
    .max(5)
    .describe("3~5개 핵심 키워드(한국어 권장)."),
  body: z
    .string()
    .min(80)
    .describe(
      "원문을 한국어로 **충실히 재구성한 본문**. 단순 2~3문장 요약 금지. " +
        "원문의 구조(소제목·순서)를 유지하고 구체적 수치·예시·인용·고유명사를 보존하세요. " +
        "원문이 길면 원문 분량에 맞춰 충분히 길게(여러 섹션). **읽기 좋게** 구조화하세요:\n" +
        "- '## 소제목'으로 구획, 핵심은 **굵게**, 나열은 불릿(-), 인용은 '> ', 코드는 ```fenced```.\n" +
        "- **여러 항목을 비교/정리할 땐 마크다운 표**를 적극 사용: `| 항목 | 값 |` 헤더 + `| --- | --- |` 구분행 + 데이터행.\n" +
        "- **수치 비교(성능·점유율·증감 등 2~6개 항목)가 있으면 차트**를 넣으세요. 코드펜스 ```chart 안에 JSON 한 줄: " +
        '```chart\\n{"title":"제목","unit":"%","data":[{"label":"A","value":88},{"label":"B","value":91}]}\\n``` ' +
        "(value 는 숫자만). 원문에 수치가 없으면 차트를 만들지 마세요.\n" +
        "표·차트는 맥락에 맞을 때만 — 억지로 넣지 말 것. 해요체. 발췌만 있으면 있는 내용만 충실히 정리(없는 내용 창작 금지).",
    ),
  category: z
    .enum(CATEGORIES)
    .describe(
      "다음 중 하나로 분류: dev(개발), design(디자인), pm(기획/PM), " +
        "marketing(마케팅), data(데이터), ai(AI 모델·연구·도구), insight(산업·인사이트).",
    ),
});

export type CardNewsText = z.infer<typeof cardNewsTextSchema>;

export interface GenerateCardNewsInput {
  originalTitle: string;
  rawContent: string;
  sourceName?: string;
  /** 폴백 카테고리(AI 분류 실패 시) */
  fallbackCategory?: Category;
  /** 모델 오버라이드(OpenAI 모델 ID). */
  model?: string;
}

export interface Enrichment {
  cardnews: CardNews;
  category: Category;
  tags: string[];
}

const CATEGORY_GUIDE = CATEGORIES.map(
  (c) => `${c}=${categories[c].label}`,
).join(", ");

/**
 * rawContent → 카드뉴스(summary/keywords/body) + 카테고리 분류.
 * AI 호출 실패 시 결정론적 폴백.
 */
export async function enrichArticle(
  input: GenerateCardNewsInput,
): Promise<Enrichment> {
  const {
    originalTitle,
    rawContent,
    sourceName,
    fallbackCategory = "ai",
    model = CARDNEWS_MODEL,
  } = input;

  // 해외 테크 블로그(techblog)는 저작권상 전문 번역 대신 "발췌 + 논평 요약".
  // 그 외 소스는 기존 동작(충실 재구성) 유지. 규칙: docs/commentary-guide.md.
  const commentary = getSourceKind(sourceName ?? "") === "techblog";

  const system = commentary
    ? "당신은 해외 테크 블로그를 한국 실무자에게 **비판적으로 리뷰**하는 AI 에디터입니다. " +
      "단순 요약·번역이 아니라 '왜 이렇게 설계했나 / 실제로 쓸 만한가'를 따지는 리뷰어예요. " +
      "저작권 보호를 위해 원문을 전문 번역·복제하지 않습니다 — 핵심을 한국어로 **재서술**하고, " +
      "꼭 필요한 문장만 짧게 인용하며, 트레이드오프·수치의 측정조건·재현 가능성·실무 적용을 " +
      "근거 있게 평가합니다. 원문이 본문의 주(主)가 되면 안 되고, 전체 내용은 원문 링크로 유도합니다. " +
      `카테고리는 다음 중 하나로 정확히 분류하세요: ${CATEGORY_GUIDE}.`
    : "당신은 해외/국내 AI·AX 아티클을 한국 실무자용으로 옮기는 AI 에디터입니다. " +
      "요약가가 아니라 **번역·재구성 에디터**입니다 — 원문의 내용을 압축해 버리지 말고, " +
      "원문이 담은 핵심 정보·맥락·수치·예시를 거의 빠짐없이 한국어로 충실히 옮깁니다. " +
      "다만 자연스러운 한국어 해요체로 읽기 좋게 다듬고, 소제목으로 구조화합니다. " +
      `카테고리는 다음 중 하나로 정확히 분류하세요: ${CATEGORY_GUIDE}.`;

  const prompt = commentary
    ? `다음 해외 테크 블로그 글을 한국 실무자용 '상세 리뷰 카드'로 작성해줘. ` +
      `전문 번역이 아니라 재서술+비판적 리뷰야. body 는 아래 마크다운 구조를 따라줘:\n` +
      `- '## 한눈에 (TL;DR)' — 무엇을 발표/주장, 왜 중요, 핵심 수치. 5~7문장 압축\n` +
      `- '## 핵심 주장' — 글이 내세우는 주장/기여 2~4개를 불릿으로(예: 성능 N% 개선, X 최초 지원)\n` +
      `- '## 어떻게 풀었나' — 접근·설계를 네 한국어로 재서술. 원문 문단 통째 번역 금지. ` +
      `핵심 문장만 1~3개 '> ' 인용으로 짧게. 수치 비교는 표/차트(\`\`\`chart) 활용(원문 수치만)\n` +
      `- '## 뜯어보기' — 비판적 검토: 설계의 트레이드오프 / 주장 수치의 측정 조건이 공정한가 / ` +
      `마케팅과 실제 기여의 경계 / 코드·벤치마크 공개로 재현·검증 가능한가\n` +
      `- '## 실무 적용' — 한국 실무자가 도입 시 걸림돌과 다음 행동(또는 더 읽을 자료)\n` +
      `- '## 한 줄 평' — 핵심 주장 한 줄 + 가장 미심쩍거나 과장으로 보이는 지점 1개\n` +
      `- 마지막 줄: '> 전문은 원문 출처에서 확인하세요.'\n` +
      `'뜯어보기'의 의심도 본문 근거로만, 없는 사실·수치 창작 금지. summary 는 2~3문장 티저, 해요체.\n\n` +
      `제목: ${originalTitle}\n` +
      (sourceName ? `출처: ${sourceName}\n` : "") +
      `\n본문:\n${rawContent.slice(0, 30000)}`
    : `다음 아티클을 한국어로 충실히 재구성해줘(요약 아님 — 원문 내용을 거의 유지). ` +
      `summary 는 짧은 티저, body 는 원문 분량에 맞춰 충분히 길고 자세하게.\n\n` +
      `제목: ${originalTitle}\n` +
      (sourceName ? `출처: ${sourceName}\n` : "") +
      `\n본문:\n${rawContent.slice(0, 30000)}`;

  try {
    const { object } = await generateObject({
      model: openai(model),
      schema: cardNewsTextSchema,
      // 본문이 길어 출력이 잘리지 않도록 충분히 크게(표·차트 포함).
      maxOutputTokens: 16384,
      system,
      prompt,
    });

    return {
      cardnews: {
        summary: object.summary,
        keywords: object.keywords,
        body: object.body,
        coverImageUrl: "",
      },
      category: object.category,
      tags: object.keywords.slice(0, 5),
    };
  } catch (err) {
    console.warn(
      "[cardnews] OpenAI 생성 실패, 폴백 사용:",
      err instanceof Error ? err.message : err,
    );
    const cardnews = fallbackCardNews(input);
    return {
      cardnews,
      category: fallbackCategory,
      tags: cardnews.keywords.slice(0, 5),
    };
  }
}

// =============================================================================
// AI 페르소나 다관점 댓글 — 수집 글에 토론 마중물 자동 생성
// =============================================================================
// 실존 인물 사칭이 아닌 원형(archetype) 페르소나. 본문 근거로만 작성하고 각 댓글은
// 사람에게 답을 던지는 질문으로 끝나 멤버 참여를 유도한다. 규칙: docs/persona-comments-guide.md.
// 생성 실패는 [] 로 graceful — 발행을 막지 않는다.

export interface PersonaComment {
  personaId: string;
  body: string;
}

const personaIds = AGENT_PERSONAS.map((p) => p.id) as [string, ...string[]];
const personaCommentsSchema = z.object({
  comments: z
    .array(
      z.object({
        personaId: z.enum(personaIds),
        body: z
          .string()
          .min(20)
          .max(600)
          .describe(
            "해당 페르소나 관점의 한국어 댓글(해요체). 2~4문장. 글의 구체 지점을 짚고 " +
              "마지막은 사람에게 던지는 열린 질문으로 끝낼 것. 본문에 없는 사실 창작 금지.",
          ),
      }),
    )
    .max(AGENT_PERSONAS.length),
});

const PERSONA_GUIDE = AGENT_PERSONAS.map(
  (p) => `- ${p.id} — ${p.name}(${p.role}): ${p.lens}`,
).join("\n");

/**
 * 수집 글 → 원형 페르소나별 다관점 댓글. 각 페르소나 1개씩.
 * AI 호출 실패 시 [] (발행 비차단).
 */
export async function generatePersonaComments(input: {
  originalTitle: string;
  rawContent: string;
  model?: string;
}): Promise<PersonaComment[]> {
  const { originalTitle, rawContent, model = CARDNEWS_MODEL } = input;
  try {
    const { object } = await generateObject({
      model: openai(model),
      schema: personaCommentsSchema,
      maxOutputTokens: 8192,
      system:
        "당신은 커뮤니티 토론을 여는 에디터입니다. 아래 원형 페르소나(개발/비개발 직군 혼합) 중 " +
        "이 글과 가장 관련 있는 **2~4명**을 골라, 각자 관점의 댓글을 하나씩 만듭니다. " +
        "이들은 실존 인물이 아니라 관점의 의인화이고, 각자 고유 영어 닉네임을 씁니다. " +
        "기술 깊은 글이면 기술 페르소나(Ada/Theo/Max)가, 디자인·사용자·시장·도입 얘기가 있으면 " +
        "비개발 페르소나(Dana/Leo)도 참여하세요. 각 댓글은 (1) 글의 구체적 내용을 근거로 하고(창작 금지), " +
        "(2) 해요체로 2~4문장, (3) 반드시 사람에게 답을 청하는 열린 질문으로 끝나 멤버의 댓글을 유도합니다.\n" +
        `페르소나(personaId — 닉네임(직군): 렌즈):\n${PERSONA_GUIDE}`,
      prompt:
        `다음 글에 대해, 관련 있는 페르소나 2~4명을 골라 각자 댓글을 작성해줘.\n\n제목: ${originalTitle}\n\n` +
        `본문:\n${rawContent.slice(0, 12000)}`,
    });
    // 스키마상 personaId 는 유효하지만, 중복 페르소나는 첫 항목만 채택.
    const seen = new Set<string>();
    return object.comments.filter((c) =>
      seen.has(c.personaId) ? false : (seen.add(c.personaId), true),
    );
  } catch (err) {
    console.warn(
      "[persona] 댓글 생성 실패(건너뜀):",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** 큐레이터 답글 — personaId 별 답. */
export interface CuratorReply {
  personaId: string;
  body: string;
}

const curatorRepliesSchema = z.object({
  replies: z
    .array(
      z.object({
        personaId: z.enum(personaIds),
        body: z
          .string()
          .min(20)
          .max(600)
          .describe(
            "해당 페르소나의 질문/관점에 대한 'AI 큐레이터'의 답글(해요체, 2~4문장). " +
              "글의 구체적 내용·근거로 질문에 직접 답하고, 본문에 없는 사실 창작 금지. 중립적·정보 제공 톤.",
          ),
      }),
    )
    .max(AGENT_PERSONAS.length),
});

/**
 * 마중물 페르소나 댓글(각자 열린 질문으로 끝남)에 대한 'AI 큐레이터'의 답글.
 * 각 페르소나 댓글당 1개 — 글 내용을 근거로 질문에 답해 토론의 첫 답을 채운다.
 * personaId 로 매칭(없으면 그 페르소나는 답 없음). 실패 시 [](발행 비차단).
 */
export async function generateCuratorReplies(input: {
  originalTitle: string;
  rawContent: string;
  personaComments: { personaId: string; body: string }[];
  model?: string;
}): Promise<CuratorReply[]> {
  const {
    originalTitle,
    rawContent,
    personaComments,
    model = CARDNEWS_MODEL,
  } = input;
  if (personaComments.length === 0) return [];
  try {
    const askList = personaComments
      .map((c) => `- ${c.personaId}: "${c.body}"`)
      .join("\n");
    const { object } = await generateObject({
      model: openai(model),
      schema: curatorRepliesSchema,
      maxOutputTokens: 8192,
      system:
        "당신은 'AI 큐레이터'입니다(이 글을 큐레이션해 올린 에디터). 아래 글에 여러 페르소나가 남긴 " +
        "댓글 각각이 사람에게 던지는 열린 질문으로 끝납니다. 답이 없으면 질문이 공허하므로, 당신이 각 " +
        "페르소나의 질문/관점에 대해 글 내용을 근거로 답하는 답글을 personaId 별로 하나씩 작성합니다. " +
        "규칙: (1) 해당 질문에 직접 답하고, (2) 글의 구체적 내용·수치·근거를 활용하되 본문에 없는 사실은 " +
        "지어내지 말 것(모르면 한계를 솔직히), (3) 해요체 2~4문장, (4) 중립적·정보 제공적 큐레이터 톤.\n" +
        `페르소나(personaId — 닉네임(직군): 렌즈):\n${PERSONA_GUIDE}`,
      prompt:
        `글 제목: ${originalTitle}\n\n본문:\n${rawContent.slice(0, 12000)}\n\n` +
        `아래 각 페르소나 댓글(열린 질문 포함)에 personaId 별로 답글을 작성해줘:\n${askList}`,
    });
    const seen = new Set<string>();
    return object.replies.filter((r) =>
      seen.has(r.personaId) ? false : (seen.add(r.personaId), true),
    );
  } catch (err) {
    console.warn(
      "[curator] 답글 생성 실패(건너뜀):",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * 'AI와 함께 써보기' — 사용자 방향성(+연결 아티클 맥락)으로 AX 공식 마크다운 초안 생성.
 * 표(| 열 |)·차트(```chart)도 맥락 맞으면 활용. 출력은 마크다운(Markdown 컴포넌트로 렌더).
 * 실패 시 throw(라우트에서 처리).
 */
export async function generateArchiveDraft(input: {
  direction: string;
  articleTitle?: string;
  articleContent?: string;
  model?: string;
}): Promise<string> {
  const {
    direction,
    articleTitle,
    articleContent,
    model = CARDNEWS_MODEL,
  } = input;

  const ctx = articleTitle
    ? `\n\n[연결된 아티클 — 이 맥락을 반영해줘]\n제목: ${articleTitle}\n내용:\n${(articleContent ?? "").slice(0, 8000)}`
    : "";

  const { text } = await generateText({
    model: openai(model),
    // 표·차트 포함 멀티섹션 한국어 글 — 잘리면 표/차트가 깨지므로 enrichArticle 과 동일하게 크게.
    maxOutputTokens: 16384,
    system:
      "당신은 The Formula 의 'AX 공식'(업무에 AI를 적용한 사례·방법) 작성을 돕는 에디터입니다. " +
      "사용자가 준 방향성과(있으면) 연결된 아티클 맥락을 바탕으로 읽기 좋은 한국어 마크다운 글을 작성합니다.\n" +
      "규칙: (1) 해요체, ##/### 소제목으로 명확히 구조화, (2) 문제 상황 → 접근/가설 → 적용 과정 → 결과 " +
      "흐름이 자연스럽게 드러나게, (3) 맥락에 맞으면 표(`| 열 | 열 |` 형식)나 차트(```chart 펜스 + " +
      'JSON `{"title","unit","data":[{"label","value"}]}`)를 활용해 가독성을 높임, ' +
      "(4) 근거 없는 과장·허위 수치 금지(모르면 일반화), (5) 마크다운 본문만 출력하고 전체를 코드펜스로 감싸지 말 것.",
    prompt: `다음 방향성으로 'AX 공식' 글을 작성해줘:\n${direction.slice(0, 2000)}${ctx}`,
  });
  return text.trim();
}

/** 하위호환 — CardNews 만 필요할 때. */
export async function generateCardNews(
  input: GenerateCardNewsInput,
): Promise<CardNews> {
  return (await enrichArticle(input)).cardnews;
}

/** 결정론적 폴백(AI 없이도 적재 가능하게). */
export function fallbackCardNews(input: GenerateCardNewsInput): CardNews {
  const { originalTitle, rawContent, sourceName } = input;
  const firstSentences = rawContent.replace(/\s+/g, " ").trim().slice(0, 240);
  const keywords = deriveKeywords(`${originalTitle} ${rawContent}`);
  return {
    summary:
      firstSentences || `${originalTitle} 에 대한 핵심을 정리한 카드뉴스예요.`,
    keywords,
    body:
      `## 핵심 요약\n\n${firstSentences}\n\n` +
      (sourceName ? `> 출처: ${sourceName}\n` : ""),
    coverImageUrl: "",
  };
}

/** 아주 단순한 키워드 추출(폴백 전용). 길이순 상위 토큰 3~5개. */
function deriveKeywords(text: string): string[] {
  const tokens = text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const t of tokens.sort((a, b) => b.length - a.length)) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(t);
    if (uniq.length >= 5) break;
  }
  return uniq.length >= 3 ? uniq : ["AX", "AI", "워크플로우"];
}
