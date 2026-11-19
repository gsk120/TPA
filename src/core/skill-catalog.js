export const skillCatalog = Object.freeze({
  calendar: '일정·약속·할 일·가족 알림의 추가, 조회(이력 포함), 변경, 완료, 취소.',
  finance: '실제 지출·수입·거래·예산의 조회·집계.',
  mail: '메일 검색·조회·요약.',
  photo: '저장된 사진·앨범 검색·조회.'
});

export const skillIds = Object.freeze(Object.keys(skillCatalog));

// Bump when the routing prompt, catalog or output contract changes.
export const skillRoutingVersion = 3;
