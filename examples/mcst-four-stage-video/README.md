# 문화체육관광부 4단 조직개편 영상

직제·직제 시행규칙과 개정문을 검증해 만든 4단 비교표를 HyperFrames로 순차 작도하는 재현 예제입니다. 원본 그림을 다시 베껴 적지 않고, `assets/mcst-four-stage-chart.svg`와 `assets/mcst-four-stage-chart.native.json`의 문구·좌표·관계를 그대로 사용합니다.

## 구성

- 화면: A3 가로 비율 `1680×1188`, 처음부터 끝까지 고정
- 길이: 14초, 30fps, 무음
- `0~8.8초`: 네 시점의 조직도 본체를 왼쪽부터 순차 완성
- `8.9~12.4초`: 시점 간 대응 점선을 `1→2`, `2→3`, `3→4` 순으로 연결
- `12.4~14초`: 완성 화면 정지

## 재현

Node.js 22 이상과 FFmpeg가 필요합니다.

```bash
node build-inline.mjs
npm run check
npm run render -- --quality high --fps 30 --output mcst-four-stage-build.mp4
```

`build-inline.mjs`가 원본 SVG를 `compositions/index.html`에 인라인으로 넣고, 조직도 본체와 시점 간 대응선을 분리해 하나의 seek-safe GSAP 타임라인을 등록합니다.

완성본은 [`docs/media/mcst-four-stage/mcst-four-stage-build.mp4`](../../docs/media/mcst-four-stage/mcst-four-stage-build.mp4)에 보관합니다.
