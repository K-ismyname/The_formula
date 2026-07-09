// =============================================================================
// 시드 스크립트 — 데모/개발용 데이터 (node --env-file=.env.local src/db/seed.ts)
// 주의: 플레인 node 로 실행하므로 상대경로 import 사용(@/ 별칭 X).
// 등급은 read-time 파생이지만, 시드는 visitCountBase/projectCount(저장값) +
// posts/interactions 로 의도적으로 5단계 tier 분포를 만든다(§11 가시 스프레드).
// =============================================================================
import { db } from "./index";
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
} from "./schema";
import { inArray } from "drizzle-orm";
import { AGENT_CURATOR_ID } from "../lib/contract";
import type { Difficulty } from "../lib/contract";
import { computeTrust } from "../lib/trust";

const now = Date.now();
const daysAgo = (d: number) => new Date(now - d * 86_400_000);

// ---- 유저 (등급 분포: master/builder/activist/contributor/sprout) ----
const SEED_USERS = [
  {
    id: AGENT_CURATOR_ID,
    name: "AI 큐레이터",
    email: null,
    image: "https://avatar.vercel.sh/agent-curator?text=AI",
    role: "AX 콘텐츠 에이전트",
    company: "The Formula",
    bio: "해외 테크 아티클을 자동 수집·해석해 카드뉴스로 큐레이션하는 AI 에이전트입니다.",
    interests: ["Curation", "LLM", "Tech Trends"],
    jobRole: "AI/ML",
    onboarded: true,
    isAgent: true,
    visitCountBase: 0,
    projectCount: 0,
  },
  {
    id: "seed-songgeunil",
    name: "송근일",
    email: "geunil@example.com",
    image: "https://avatar.vercel.sh/songgeunil",
    role: "Backend Developer",
    company: "Tech Startup",
    bio: "AI로 개발 프로세스를 혁신하는 백엔드 개발자. 복잡한 시스템을 더 빠르고 정확하게 만드는 방법을 연구합니다.",
    interests: ["AI-Assisted Development", "System Architecture", "DevOps"],
    jobRole: "개발",
    onboarded: true,
    isAgent: false,
    visitCountBase: 60,
    projectCount: 12, // → master
  },
  {
    id: "seed-kimminseo",
    name: "김민서",
    email: "minseo@example.com",
    image: "https://avatar.vercel.sh/kimminseo",
    role: "Product Designer",
    company: "Design Studio",
    bio: "디자인 시스템과 AI의 접점을 탐구하는 프로덕트 디자이너. 반복 작업을 자동화하고 크리에이티브에 집중합니다.",
    interests: ["Design System", "AI Tools", "UX Research"],
    jobRole: "디자인",
    onboarded: true,
    isAgent: false,
    visitCountBase: 40,
    projectCount: 10, // → builder
  },
  {
    id: "seed-leejunho",
    name: "이준호",
    email: "junho@example.com",
    image: "https://avatar.vercel.sh/leejunho",
    role: "Product Manager",
    company: "Series B Startup",
    bio: "데이터 기반 의사결정과 AI를 결합해 제품을 만드는 PM. 리서치부터 스펙까지 AI를 업무 전반에 녹여냅니다.",
    interests: ["User Research", "Data-driven PM", "AI Productivity"],
    jobRole: "PM",
    onboarded: true,
    isAgent: false,
    visitCountBase: 30,
    projectCount: 5, // → activist
  },
  {
    id: "seed-parkseoyeon",
    name: "박서연",
    email: "seoyeon@example.com",
    image: "https://avatar.vercel.sh/parkseoyeon",
    role: "Growth Marketer",
    company: "E-commerce",
    bio: "퍼포먼스 마케팅에 AI를 접목해 성과를 극대화하는 그로스 마케터. 데이터와 크리에이티브의 균형을 추구합니다.",
    interests: ["Performance Marketing", "AI Copywriting", "Growth"],
    jobRole: "마케팅",
    onboarded: true,
    isAgent: false,
    visitCountBase: 20,
    projectCount: 2, // → contributor
  },
  {
    id: "seed-junghayoon",
    name: "정하윤",
    email: "hayoon@example.com",
    image: "https://avatar.vercel.sh/junghayoon",
    role: "Data Engineer",
    company: "Fintech",
    bio: "데이터 인프라와 AI 모니터링 자동화를 담당하는 데이터 엔지니어. 안정적인 파이프라인 운영을 추구합니다.",
    interests: ["Data Pipeline", "MLOps", "Automation"],
    jobRole: "데이터",
    onboarded: true,
    isAgent: false,
    visitCountBase: 8,
    projectCount: 0, // → sprout
  },
] as const;

// ---- 카드뉴스 (AI 큐레이터 작성) ----
const CARDNEWS = [
  {
    id: "seed-post-cn-1",
    title: "코딩 에이전트는 어떻게 '맥락'을 기억하는가",
    oneLiner: "긴 작업에서도 길을 잃지 않는 에이전트의 비밀은 컨텍스트 압축과 외부 메모리예요.",
    category: "ai" as const,
    tags: ["agent", "context", "memory", "ai"],
    difficulty: "intermediate" as Difficulty,
    workType: "분석",
    verified: true,
    sourceName: "The Pragmatic Engineer",
    sourceUrl: "https://newsletter.pragmaticengineer.com/",
    collectedAt: daysAgo(0),
    createdAt: daysAgo(0),
    cardnews: {
      summary:
        "AI 코딩 에이전트가 긴 작업에서도 맥락을 유지하는 핵심은 '컨텍스트 압축'과 '외부 메모리'다. 대화가 길어지면 요약본을 만들어 토큰을 절약하고, 중요한 결정은 파일 기반 메모리에 영속화한다.",
      keywords: ["컨텍스트 압축", "외부 메모리", "에이전트 루프"],
      body: "## 핵심 요약\n\n긴 코딩 세션에서 에이전트가 길을 잃지 않으려면 두 가지가 필요하다.\n\n1. **컨텍스트 압축** — 대화가 길어지면 자동 요약으로 토큰을 절약\n2. **외부 메모리** — 결정·제약을 파일에 영속화해 세션을 넘겨도 유지\n\n실무에서는 이 둘을 결합해 '사람은 방향을, 에이전트는 실행을' 맡기는 구조가 효과적이다.",
      coverImageUrl: "",
    },
  },
  {
    id: "seed-post-cn-2",
    title: "프로덕트 팀이 LLM 평가를 자동화하는 5가지 패턴",
    oneLiner: "'눈으로 확인'은 확장되지 않아요. 다섯 가지 패턴으로 LLM 평가를 자동화해요.",
    category: "insight" as const,
    tags: ["eval", "llm", "product", "ai"],
    difficulty: "advanced" as Difficulty,
    workType: "분석",
    verified: false,
    sourceName: "Hacker News",
    sourceUrl: "https://news.ycombinator.com/",
    collectedAt: daysAgo(1),
    createdAt: daysAgo(1),
    cardnews: {
      summary:
        "LLM 기능을 제품에 넣을 때 '눈으로 확인'은 확장되지 않는다. 골든셋·LLM-as-judge·회귀 스냅샷·사용자 피드백 루프·오프라인 A/B 다섯 패턴으로 평가를 자동화하면 배포 신뢰도가 급상승한다.",
      keywords: ["LLM-as-judge", "골든셋", "회귀 테스트"],
      body: "## 5가지 평가 패턴\n\n- **골든셋**: 대표 입력-기대출력 쌍을 고정\n- **LLM-as-judge**: 다른 모델이 채점\n- **회귀 스냅샷**: 프롬프트 변경 전후 diff\n- **피드백 루프**: 좋아요/신고를 데이터셋으로\n- **오프라인 A/B**: 배포 전 후보 비교\n\n핵심은 '사람의 눈'을 자동화 가능한 신호로 바꾸는 것.",
      coverImageUrl: "",
    },
  },
  {
    id: "seed-post-cn-3",
    title: "디자이너를 위한 AI 워크플로우: 반복은 자동, 취향은 사람",
    oneLiner: "AI는 디자이너를 대체하지 않아요. 반복은 자동화하고 취향에 집중해요.",
    category: "design" as const,
    tags: ["design", "workflow", "automation"],
    difficulty: "beginner" as Difficulty,
    workType: "디자인",
    verified: true,
    sourceName: "Smashing Magazine",
    sourceUrl: "https://www.smashingmagazine.com/",
    collectedAt: daysAgo(2),
    createdAt: daysAgo(2),
    cardnews: {
      summary:
        "AI는 디자이너를 대체하지 않는다. 토큰 추출·에셋 리사이즈·카피 변형 같은 반복을 자동화하고, 디자이너는 방향과 취향이라는 고부가 판단에 집중하는 분업이 생산성을 끌어올린다.",
      keywords: ["디자인 자동화", "토큰", "분업"],
      body: "## 자동화 가능 영역\n\n반복적이고 규칙적인 작업부터 넘긴다.\n\n- 디자인 토큰 추출/동기화\n- 다중 해상도 에셋 생성\n- 마이크로카피 변형 A/B\n\n취향·브랜드 일관성·최종 판단은 사람이 쥔다. '반복은 자동, 취향은 사람'.",
      coverImageUrl: "",
    },
  },
  {
    id: "seed-post-cn-4",
    title: "마케팅 카피, AI로 A/B 시안을 10배 빠르게 뽑는 법",
    oneLiner: "고성과 패턴을 학습시켜 승률 높은 카피 시안을 대량 생성하는 워크플로우예요.",
    category: "marketing" as const,
    tags: ["카피라이팅", "A/B", "growth"],
    difficulty: "beginner" as Difficulty,
    workType: "마케팅",
    verified: true,
    sourceName: "First Round Review",
    sourceUrl: "https://review.firstround.com/",
    collectedAt: daysAgo(1),
    createdAt: daysAgo(1),
    cardnews: {
      summary:
        "광고 카피 생산은 AI로 가장 빠르게 효과를 보는 영역이다. 과거 고성과(CTR 상위) 카피의 후킹·베네핏·CTA 패턴을 학습시키면 승률 높은 시안을 대량 생성해 A/B 사이클을 10배로 단축할 수 있다.",
      keywords: ["고성과 패턴", "카피 생성", "A/B 가속"],
      body: "## 카피 자동화의 핵심\n\n무작정 생성하면 양만 늘어요. 효과는 '패턴 학습'에서 나와요.\n\n1. CTR 상위 20% 카피를 모아요\n2. 후킹·베네핏·CTA 패턴을 추출해요\n3. 그 패턴으로 수십 개 변형을 생성해요\n4. 상위 시안만 A/B에 올려요\n\n'양산'이 아니라 '승률 복제'가 목표예요.",
      coverImageUrl: "",
    },
  },
  {
    id: "seed-post-cn-5",
    title: "데이터 파이프라인 이상 탐지, 룰 기반을 넘어서기",
    oneLiner: "과거 장애 패턴을 학습시켜 룰 기반보다 정확한 탐지를 만드는 접근이에요.",
    category: "data" as const,
    tags: ["모니터링", "이상탐지", "MLOps"],
    difficulty: "advanced" as Difficulty,
    workType: "분석",
    verified: false,
    sourceName: "Towards Data Science",
    sourceUrl: "https://towardsdatascience.com/",
    collectedAt: daysAgo(3),
    createdAt: daysAgo(3),
    cardnews: {
      summary:
        "정적 임계값(룰) 기반 모니터링은 오탐과 누락이 잦다. 과거 장애·정상 패턴을 학습해 통계+패턴 매칭으로 이상을 탐지하면 정확도가 오르고 오탐이 크게 준다. 핵심은 '정상의 모양'을 데이터로 정의하는 것.",
      keywords: ["이상 탐지", "패턴 학습", "오탐 감소"],
      body: "## 룰 기반의 한계\n\n임계값은 평시엔 잘 맞지만 패턴이 바뀌면 무너져요.\n\n- 과거 장애 로그 + 정상 패턴을 함께 학습\n- 통계 + 패턴 매칭으로 탐지 규칙 초안 생성\n- 실시간 모니터링 + 알림 연동\n\n'정상의 모양'을 데이터로 정의하면 탐지가 훨씬 단단해져요.",
      coverImageUrl: "",
    },
  },
];

// ---- Formula (유저 작성, formulas.ts 계승) ----
const FORMULAS = [
  {
    id: "seed-post-fm-1",
    authorId: "seed-songgeunil",
    title: "레거시 API 리팩토링 자동화",
    oneLiner: "200개 엔드포인트를 AI 패턴 학습으로 4일 만에 마이그레이션했어요.",
    category: "dev" as const,
    tags: ["리팩토링", "자동화", "코드 마이그레이션"],
    difficulty: "advanced" as Difficulty,
    workType: "코드",
    verified: true,
    createdAt: daysAgo(3),
    formula: {
      problem: "200개 이상의 레거시 API 엔드포인트를 새 아키텍처로 마이그레이션해야 하는 상황",
      hypothesis: "AI에 패턴을 학습시킨 뒤 반복 변환을 자동화하면 수작업 대비 80% 이상 시간을 절감할 수 있다",
      tools: ["Claude Code", "Cursor", "AST Parser"],
      prompt: "다음 컨벤션을 따라 이 API를 새 아키텍처로 변환해줘. 입력/출력 타입을 유지하고 테스트도 같은 패턴으로 생성해.",
      process: "1) 기존 API 5개를 수동 리팩토링하며 패턴 문서화\n2) Claude에 패턴·컨벤션을 컨텍스트로 제공\n3) 나머지를 배치 단위로 변환 + 코드리뷰\n4) 테스트도 동일 패턴으로 자동 생성",
      result: "전체 마이그레이션을 4일 만에 완료. 일관된 패턴 적용으로 에러율도 수동 대비 낮음",
      timeSaved: "3주 → 4일",
    },
  },
  {
    id: "seed-post-fm-2",
    authorId: "seed-songgeunil",
    title: "반복 CRUD 기능 초고속 개발",
    oneLiner: "CRUD 모듈 하나를 템플릿으로, 15개 화면을 2일 만에 복제했어요.",
    category: "dev" as const,
    tags: ["CRUD", "코드 생성", "생산성"],
    difficulty: "intermediate" as Difficulty,
    workType: "코드",
    verified: false,
    createdAt: daysAgo(5),
    formula: {
      problem: "관리자 페이지의 유사한 CRUD 화면 15개를 개발해야 하는 상황",
      hypothesis: "완성된 CRUD 모듈 하나를 템플릿으로 제공하면 나머지를 정확히 복제/변형할 수 있다",
      tools: ["Cursor", "Claude Code"],
      prompt: "이 CRUD 모듈을 레퍼런스로, {엔티티} 용 CRUD를 동일 구조로 생성해줘. 비즈니스 규칙 차이만 주석으로 표시해.",
      process: "1) 가장 복잡한 CRUD 1개를 직접 완성(테스트 포함)\n2) 레퍼런스로 나머지 엔티티별 변형 요청\n3) 엔티티별 로직 차이만 수동 조정\n4) E2E 테스트도 동일 패턴 생성",
      result: "15개 CRUD 모듈을 2일 만에 완성. 코드 일관성도 수동 대비 높음",
      timeSaved: "2주 → 2일",
    },
  },
  {
    id: "seed-post-fm-3",
    authorId: "seed-kimminseo",
    title: "디자인 시스템 토큰 자동 추출",
    oneLiner: "매주 4시간 걸리던 토큰 정리를 커맨드 하나로 15분에 끝냈어요.",
    category: "design" as const,
    tags: ["디자인 시스템", "자동화", "Figma"],
    difficulty: "intermediate" as Difficulty,
    workType: "디자인",
    verified: true,
    relatedArticleId: "seed-post-cn-3",
    createdAt: daysAgo(4),
    formula: {
      problem: "Figma 디자인 시스템에서 개발용 토큰을 수동 정리하는 데 매주 반나절 소요",
      hypothesis: "Figma API raw 데이터를 AI로 정규화하면 수작업 없이 토큰 파일을 생성할 수 있다",
      tools: ["ChatGPT", "Figma API", "Style Dictionary"],
      prompt: "이 Figma 변수 JSON을 우리 네이밍 컨벤션에 맞춰 Style Dictionary 포맷으로 정규화해줘.",
      process: "1) Figma API로 컬러/타이포/스페이싱 추출\n2) GPT에 네이밍 규칙과 함께 정규화 요청\n3) Style Dictionary 포맷 변환\n4) PR 자동 생성까지 파이프라인화",
      result: "매주 4시간 걸리던 토큰 업데이트가 커맨드 하나로 15분 내 완료",
      timeSaved: "4시간 → 15분",
    },
  },
  {
    id: "seed-post-fm-4",
    authorId: "seed-leejunho",
    title: "사용자 인터뷰 분석 자동화",
    oneLiner: "20건 녹취록을 JTBD 프레임으로 하루 만에 5개 인사이트로 압축했어요.",
    category: "pm" as const,
    tags: ["사용자 리서치", "인터뷰 분석", "PM"],
    difficulty: "beginner" as Difficulty,
    workType: "분석",
    verified: false,
    createdAt: daysAgo(6),
    formula: {
      problem: "20건의 인터뷰 녹취록 분석·인사이트 도출에 1주일 소요",
      hypothesis: "구조화된 프롬프트로 분석하면 핵심 패턴을 빠르게 추출할 수 있다",
      tools: ["Claude", "Notion AI", "Dovetail"],
      prompt: "이 녹취록들을 Jobs-to-be-done 프레임으로 분석해 반복되는 pain point를 인용과 함께 클러스터링해줘.",
      process: "1) 녹취록을 발화자/맥락/감정 태깅\n2) Claude에 JTBD 프레임 적용\n3) pain point 자동 클러스터링\n4) 근거 인용과 함께 리포트 생성",
      result: "20건에서 5개 핵심 인사이트를 하루 만에 도출, 누락 없음 확인",
      timeSaved: "5일 → 1일",
    },
  },
  {
    id: "seed-post-fm-5",
    authorId: "seed-parkseoyeon",
    title: "마케팅 카피 A/B 테스트 가속화",
    oneLiner: "고성과 패턴을 학습시켜 카피 생산성 10배, CTR 12% 향상을 만들었어요.",
    category: "marketing" as const,
    tags: ["마케팅", "A/B 테스트", "카피라이팅"],
    difficulty: "beginner" as Difficulty,
    workType: "마케팅",
    verified: true,
    relatedArticleId: "seed-post-cn-4",
    createdAt: daysAgo(7),
    formula: {
      problem: "광고 카피 20개 시안 작성 + A/B 세팅에 매번 3일 소요",
      hypothesis: "고성과 카피 패턴을 학습시키면 승률 높은 시안을 대량 생성할 수 있다",
      tools: ["GPT-4", "Google Ads API"],
      prompt: "지난 6개월 CTR 상위 카피의 후킹/베네핏/CTA 패턴을 분석하고, 그 패턴으로 40개 변형을 생성해줘.",
      process: "1) CTR 상위 20% 카피 추출\n2) GPT에 고성과 패턴 분석\n3) 패턴 기반 40개 생성 → 상위 20개 선별\n4) Ads API로 A/B 자동 세팅",
      result: "카피 생산성 10배, AI 카피 CTR이 평균 12% 높음",
      timeSaved: "3일 → 3시간",
    },
  },
  {
    id: "seed-post-fm-6",
    authorId: "seed-junghayoon",
    title: "데이터 파이프라인 이상 탐지 자동화",
    oneLiner: "과거 장애 패턴을 학습시켜 탐지 정확도 95%+, 오탐 60% 감소시켰어요.",
    category: "data" as const,
    tags: ["데이터 엔지니어링", "모니터링", "자동화"],
    difficulty: "advanced" as Difficulty,
    workType: "분석",
    verified: false,
    relatedArticleId: "seed-post-cn-5",
    createdAt: daysAgo(8),
    formula: {
      problem: "파이프라인 모니터링에 매일 1시간을 쓰지만 이상을 놓치는 경우가 잦음",
      hypothesis: "AI가 과거 이상 패턴을 학습하면 룰 기반보다 정확한 탐지가 가능하다",
      tools: ["Claude", "Grafana", "Python"],
      prompt: "이 6개월 장애 로그와 정상 패턴으로 통계+패턴 매칭 기반 이상 탐지 규칙 초안을 작성해줘.",
      process: "1) 과거 장애 로그·정상 패턴 수집\n2) Claude로 탐지 규칙 초안\n3) Python 실시간 모니터링 구현\n4) Grafana + Slack 알림 연동",
      result: "수동 모니터링 제거, 탐지 정확도 95%+, 오탐 60% 감소",
      timeSaved: "일 1시간 → 알림 확인",
    },
  },
];

// ---- 모임 (스터디 2 + 프로젝트 1) ----
const ACTIVITIES = [
  {
    id: "seed-act-1",
    type: "study" as const,
    title: "Claude Code로 사이드프로젝트 6주 완주 스터디",
    summary: "AI 페어 프로그래밍으로 매주 하나씩 기능을 출시하는 실전 스터디예요.",
    description:
      "6주간 매주 모여 Claude Code·Cursor를 활용한 페어 프로그래밍으로 사이드프로젝트를 완성합니다. 커리큘럼: 1주 셋업·프롬프트 기초, 2~5주 기능 단위 출시, 6주 회고·배포. 산출물은 배포된 데모와 공식(Formula) 1편씩이에요.",
    status: "recruiting" as const,
    ownerId: "seed-songgeunil",
    ownerName: "송근일",
    tags: ["Claude Code", "사이드프로젝트", "페어프로그래밍"],
    capacity: 8,
    season: "2026 시즌1",
    createdAt: daysAgo(2),
  },
  {
    id: "seed-act-2",
    type: "study" as const,
    title: "프로덕트 팀을 위한 LLM 평가 자동화 스터디",
    summary: "골든셋부터 LLM-as-judge까지, 평가 파이프라인을 함께 만들어요.",
    description:
      "LLM 기능을 제품에 안전하게 배포하기 위한 평가 자동화를 4주간 다룹니다. 골든셋 구축, LLM-as-judge, 회귀 스냅샷, 오프라인 A/B를 직접 구현해보고 각자 팀 사례에 적용합니다.",
    status: "ongoing" as const,
    ownerId: "seed-leejunho",
    ownerName: "이준호",
    tags: ["LLM", "eval", "product"],
    capacity: 6,
    season: "2026 시즌1",
    createdAt: daysAgo(6),
  },
  {
    id: "seed-act-3",
    type: "project" as const,
    title: "AX 워크플로우 모음집 오픈소스 프로젝트",
    summary: "커뮤니티 공식을 모아 검색·복제 가능한 오픈소스 라이브러리를 만들어요.",
    description:
      "The Formula의 공식들을 구조화해 누구나 검색·복제할 수 있는 오픈소스 라이브러리를 만드는 프로젝트입니다. 모집 역할: 프론트엔드 2, 백엔드 1, 데이터/큐레이션 1. 진행 단계: 기획 → MVP → 공개 베타.",
    status: "recruiting" as const,
    ownerId: "seed-kimminseo",
    ownerName: "김민서",
    tags: ["오픈소스", "라이브러리", "큐레이션"],
    capacity: 4,
    season: null,
    createdAt: daysAgo(1),
  },
];

// ---- 지원 (모임별 1~2건) ----
const APPLICATIONS = [
  {
    id: "seed-app-1",
    activityId: "seed-act-1",
    userId: "seed-junghayoon",
    userName: "정하윤",
    message: "데이터 파이프라인 자동화 경험을 살려 합류하고 싶어요. 6주 완주 자신 있어요!",
    status: "accepted" as const,
    createdAt: daysAgo(1),
  },
  {
    id: "seed-app-2",
    activityId: "seed-act-3",
    userId: "seed-parkseoyeon",
    userName: "박서연",
    message: "큐레이션·카피 정리를 맡고 싶어요. 마케팅 관점도 보탤게요.",
    status: "pending" as const,
    createdAt: daysAgo(0),
  },
];

// ---- 저장(북마크): (userId, postId) 쌍 ----
const BOOKMARKS = [
  { id: "seed-bm-1", userId: "seed-songgeunil", postId: "seed-post-cn-1" },
  { id: "seed-bm-2", userId: "seed-songgeunil", postId: "seed-post-fm-3" },
  { id: "seed-bm-3", userId: "seed-kimminseo", postId: "seed-post-fm-1" },
  { id: "seed-bm-4", userId: "seed-kimminseo", postId: "seed-post-cn-3" },
  { id: "seed-bm-5", userId: "seed-leejunho", postId: "seed-post-fm-1" },
  { id: "seed-bm-6", userId: "seed-leejunho", postId: "seed-post-cn-2" },
  { id: "seed-bm-7", userId: "seed-parkseoyeon", postId: "seed-post-fm-1" },
  { id: "seed-bm-8", userId: "seed-junghayoon", postId: "seed-post-fm-1" },
  { id: "seed-bm-9", userId: "seed-junghayoon", postId: "seed-post-fm-6" },
];

// ---- 팔로우: (followerId, followingId) 쌍 ----
const FOLLOWS = [
  { id: "seed-fo-1", followerId: "seed-junghayoon", followingId: "seed-songgeunil" },
  { id: "seed-fo-2", followerId: "seed-parkseoyeon", followingId: "seed-songgeunil" },
  { id: "seed-fo-3", followerId: "seed-leejunho", followingId: "seed-songgeunil" },
  { id: "seed-fo-4", followerId: "seed-kimminseo", followingId: "seed-songgeunil" },
  { id: "seed-fo-5", followerId: "seed-songgeunil", followingId: "seed-kimminseo" },
  { id: "seed-fo-6", followerId: "seed-junghayoon", followingId: "seed-kimminseo" },
  { id: "seed-fo-7", followerId: "seed-leejunho", followingId: "seed-parkseoyeon" },
];

// ---- 멤버 저장(member_bookmark): (userId, memberId) 쌍 ----
const MEMBER_BOOKMARKS = [
  { id: "seed-mb-1", userId: "seed-kimminseo", memberId: "seed-songgeunil" },
  { id: "seed-mb-2", userId: "seed-leejunho", memberId: "seed-songgeunil" },
  { id: "seed-mb-3", userId: "seed-junghayoon", memberId: "seed-songgeunil" },
  { id: "seed-mb-4", userId: "seed-songgeunil", memberId: "seed-kimminseo" },
  { id: "seed-mb-5", userId: "seed-parkseoyeon", memberId: "seed-kimminseo" },
  { id: "seed-mb-6", userId: "seed-songgeunil", memberId: "seed-leejunho" },
];

// ---- 채팅(conversation): user1Id<user2Id 정규화 페어 ----
const normalizePair = (a: string, b: string): [string, string] =>
  a < b ? [a, b] : [b, a];

const CONVERSATIONS = [
  {
    id: "seed-conv-1",
    a: "seed-songgeunil",
    b: "seed-kimminseo",
    createdAt: daysAgo(3),
    lastMessageAt: daysAgo(1),
  },
  {
    id: "seed-conv-2",
    a: "seed-songgeunil",
    b: "seed-leejunho",
    createdAt: daysAgo(2),
    lastMessageAt: daysAgo(0),
  },
].map((c) => {
  const [user1Id, user2Id] = normalizePair(c.a, c.b);
  return { id: c.id, user1Id, user2Id, createdAt: c.createdAt, lastMessageAt: c.lastMessageAt };
});

// ---- 메시지(message): readAt null = 미읽음 ----
const MESSAGES = [
  {
    id: "seed-msg-1",
    conversationId: "seed-conv-1",
    senderId: "seed-kimminseo",
    body: "근일님, 레거시 API 리팩토링 공식 잘 봤어요! 프롬프트 컨벤션 어떻게 잡으셨는지 궁금해요.",
    readAt: daysAgo(2),
    createdAt: daysAgo(3),
  },
  {
    id: "seed-msg-2",
    conversationId: "seed-conv-1",
    senderId: "seed-songgeunil",
    body: "안녕하세요! 기존 코드 5개를 수동으로 먼저 정리하면서 패턴을 문서로 뽑아뒀어요. 그걸 컨텍스트로 넣었습니다.",
    readAt: daysAgo(2),
    createdAt: daysAgo(2),
  },
  {
    id: "seed-msg-3",
    conversationId: "seed-conv-1",
    senderId: "seed-kimminseo",
    body: "오 역시 그 단계가 핵심이군요. 디자인 토큰 쪽에도 적용해볼게요 🙏",
    readAt: null, // 근일이 아직 안 읽음
    createdAt: daysAgo(1),
  },
  {
    id: "seed-msg-4",
    conversationId: "seed-conv-2",
    senderId: "seed-songgeunil",
    body: "준호님, LLM 평가 자동화 스터디 자리 남았을까요? 합류하고 싶어요.",
    readAt: daysAgo(1),
    createdAt: daysAgo(2),
  },
  {
    id: "seed-msg-5",
    conversationId: "seed-conv-2",
    senderId: "seed-leejunho",
    body: "네 환영합니다! 이번 주 목요일 8시 온라인이에요. 링크 곧 공유드릴게요.",
    readAt: null, // 근일이 아직 안 읽음
    createdAt: daysAgo(0),
  },
];

async function main() {
  console.log("🌱 Seeding The Formula …");

  const userIds = SEED_USERS.map((u) => u.id);
  const postIds = [...CARDNEWS, ...FORMULAS].map((p) => p.id);

  const activityIds = ACTIVITIES.map((a) => a.id);
  const conversationIds = CONVERSATIONS.map((c) => c.id);

  // 1) 기존 시드 정리 (실제 로그인 유저는 건드리지 않음)
  //    FK cascade 가 있지만 명시적으로 자식부터 정리해 멱등성 보장.
  await db.delete(applications).where(inArray(applications.activityId, activityIds));
  await db.delete(activities).where(inArray(activities.id, activityIds));
  await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
  await db.delete(conversations).where(inArray(conversations.id, conversationIds));
  await db.delete(memberBookmarks).where(inArray(memberBookmarks.userId, userIds));
  await db.delete(bookmarks).where(inArray(bookmarks.postId, postIds));
  await db.delete(follows).where(inArray(follows.followerId, userIds));
  await db.delete(interactions).where(inArray(interactions.postId, postIds));
  await db.delete(posts).where(inArray(posts.id, postIds));
  await db.delete(users).where(inArray(users.id, userIds));

  // 2) 유저
  await db.insert(users).values(
    SEED_USERS.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      role: u.role,
      company: u.company,
      bio: u.bio,
      interests: [...u.interests],
      jobRole: u.jobRole,
      onboarded: u.onboarded,
      isAgent: u.isAgent,
      visitCountBase: u.visitCountBase,
      projectCount: u.projectCount,
      createdAt: daysAgo(30),
    })),
  );

  // 3) 포스트 — 카드뉴스(agent) + Formula(user)
  const userById = new Map<string, (typeof SEED_USERS)[number]>(
    SEED_USERS.map((u) => [u.id, u]),
  );
  await db.insert(posts).values([
    ...CARDNEWS.map((p) => ({
      id: p.id,
      postType: "cardnews" as const,
      title: p.title,
      oneLiner: p.oneLiner,
      category: p.category,
      tags: [...p.tags],
      difficulty: p.difficulty,
      workType: p.workType,
      verified: p.verified,
      authorType: "agent" as const,
      authorId: AGENT_CURATOR_ID,
      authorName: "AI 큐레이터",
      sourceName: p.sourceName,
      sourceUrl: p.sourceUrl,
      collectedAt: p.collectedAt,
      cardnews: p.cardnews,
      formula: null,
      relatedArticleId: null,
      createdAt: p.createdAt,
    })),
    ...FORMULAS.map((p) => ({
      id: p.id,
      postType: "formula" as const,
      title: p.title,
      oneLiner: p.oneLiner,
      category: p.category,
      tags: [...p.tags],
      difficulty: p.difficulty,
      workType: p.workType,
      verified: p.verified,
      authorType: "user" as const,
      authorId: p.authorId,
      authorName: userById.get(p.authorId)?.name ?? "익명",
      sourceName: null,
      sourceUrl: null,
      collectedAt: null,
      cardnews: null,
      formula: p.formula,
      relatedArticleId:
        "relatedArticleId" in p ? p.relatedArticleId ?? null : null,
      createdAt: p.createdAt,
    })),
  ]);

  // 4) 인터랙션 — 데모용 좋아요/댓글/조회
  const humanIds = SEED_USERS.filter((u) => !u.isAgent).map((u) => u.id);
  const allPostIds = [...CARDNEWS, ...FORMULAS].map((p) => p.id);
  const rows: {
    postId: string;
    userId: string;
    type: "view" | "like" | "comment";
    body: string | null;
    createdAt: Date;
  }[] = [];

  const COMMENTS = [
    "이거 바로 적용해봤는데 효과 좋네요 🙌",
    "프롬프트 공유 감사합니다. 우리 팀 워크플로우에 넣어볼게요.",
    "전후 결과가 구체적이라 설득력 있네요.",
    "비슷한 고민이었는데 방향 잡혔어요!",
    "도구 조합이 신선합니다. 참고할게요.",
  ];

  allPostIds.forEach((pid, i) => {
    // 좋아요: 포스트마다 일부 유저가
    humanIds.forEach((uid, j) => {
      if ((i + j) % 2 === 0) {
        rows.push({ postId: pid, userId: uid, type: "like", body: null, createdAt: daysAgo(1) });
      }
    });
    // 조회 — 기본 1인 1조회
    humanIds.forEach((uid) =>
      rows.push({ postId: pid, userId: uid, type: "view", body: null, createdAt: daysAgo(1) }),
    );
    // 조회수 데모: 앞쪽(인기) 포스트에 추가 view 를 더 쌓아 조회수 스프레드를 만든다.
    const extraViews = Math.max(0, 6 - i); // i=0 → +6, i=1 → +5 …
    for (let k = 0; k < extraViews; k++) {
      rows.push({
        postId: pid,
        userId: humanIds[k % humanIds.length],
        type: "view",
        body: null,
        createdAt: daysAgo(2),
      });
    }
    // 댓글: 포스트마다 1~2개
    rows.push({
      postId: pid,
      userId: humanIds[i % humanIds.length],
      type: "comment",
      body: COMMENTS[i % COMMENTS.length],
      createdAt: daysAgo(0),
    });
    if (i % 2 === 0) {
      rows.push({
        postId: pid,
        userId: humanIds[(i + 1) % humanIds.length],
        type: "comment",
        body: COMMENTS[(i + 2) % COMMENTS.length],
        createdAt: daysAgo(0),
      });
    }
  });

  await db.insert(interactions).values(rows);

  // 5) 모임 + 지원
  await db.insert(activities).values(
    ACTIVITIES.map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      summary: a.summary,
      description: a.description,
      status: a.status,
      ownerId: a.ownerId,
      ownerName: a.ownerName,
      tags: [...a.tags],
      capacity: a.capacity,
      season: a.season,
      createdAt: a.createdAt,
    })),
  );
  await db.insert(applications).values(
    APPLICATIONS.map((a) => ({
      id: a.id,
      activityId: a.activityId,
      userId: a.userId,
      userName: a.userName,
      message: a.message,
      status: a.status,
      createdAt: a.createdAt,
    })),
  );

  // 6) 저장(북마크) + 팔로우
  await db.insert(bookmarks).values(
    BOOKMARKS.map((b) => ({
      id: b.id,
      userId: b.userId,
      postId: b.postId,
      createdAt: daysAgo(1),
    })),
  );
  await db.insert(follows).values(
    FOLLOWS.map((f) => ({
      id: f.id,
      followerId: f.followerId,
      followingId: f.followingId,
      createdAt: daysAgo(2),
    })),
  );

  // 6.5) 멤버 저장 + 채팅(대화/메시지)
  await db.insert(memberBookmarks).values(
    MEMBER_BOOKMARKS.map((m) => ({
      id: m.id,
      userId: m.userId,
      memberId: m.memberId,
      createdAt: daysAgo(1),
    })),
  );
  await db.insert(conversations).values(
    CONVERSATIONS.map((c) => ({
      id: c.id,
      user1Id: c.user1Id,
      user2Id: c.user2Id,
      createdAt: c.createdAt,
      lastMessageAt: c.lastMessageAt,
    })),
  );
  await db.insert(messages).values(
    MESSAGES.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      senderId: m.senderId,
      body: m.body,
      readAt: m.readAt,
      createdAt: m.createdAt,
    })),
  );
  console.log(
    `✓ activities=${ACTIVITIES.length} applications=${APPLICATIONS.length} bookmarks=${BOOKMARKS.length} follows=${FOLLOWS.length} memberBookmarks=${MEMBER_BOOKMARKS.length} conversations=${CONVERSATIONS.length} messages=${MESSAGES.length}`,
  );

  // 7) 검증 — 파생 등급 분포 출력
  console.log(`✓ users=${SEED_USERS.length} posts=${allPostIds.length} interactions=${rows.length}`);
  for (const u of SEED_USERS.filter((x) => !x.isAgent)) {
    const authored = FORMULAS.filter((f) => f.authorId === u.id).map((f) => f.id);
    const formulaCount = authored.length;
    const likesReceived = rows.filter((r) => r.type === "like" && authored.includes(r.postId)).length;
    const commentCount = rows.filter((r) => r.type === "comment" && r.userId === u.id).length;
    const viewCount = u.visitCountBase + rows.filter((r) => r.type === "view" && r.userId === u.id).length;
    const t = computeTrust({
      visitCount: viewCount,
      commentCount,
      formulaCount,
      likesReceived,
      projectCount: u.projectCount,
    });
    console.log(`  ${u.name.padEnd(4)} → ${t.trustScore}° ${t.badgeLabel} (${t.tier})`);
  }

  console.log("✅ Seed complete.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  });
