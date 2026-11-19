export const skillCatalog = Object.freeze({
  calendar: '약속·방문·할 일·가족 알림의 등록, 조회, 변경, 완료, 취소 및 일정 이력. 사진 촬영 약속을 잡는 일도 포함한다.',
  finance: '실제 지출·수입·거래·예산의 조회 또는 집계. 카드값이나 식비가 얼마인지 묻는 요청을 포함한다.',
  mail: '메일 검색, 조회, 요약. 결제 내역이나 일정 공지가 담긴 메일 자체를 찾는 요청도 포함한다.',
  photo: '이미 저장된 사진이나 앨범의 검색과 조회.'
});

export const skillIds = Object.freeze(Object.keys(skillCatalog));

// Bump when the routing prompt, catalog or output contract changes.
export const skillRoutingVersion = 2;
