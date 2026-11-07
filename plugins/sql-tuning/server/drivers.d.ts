// 드라이버는 adapters/* 의 좁은 모양(OracleDriver · PgClient)으로만 쓴다 — 패키지 타입은 들이지 않는다
declare module 'oracledb'
declare module 'pg'
