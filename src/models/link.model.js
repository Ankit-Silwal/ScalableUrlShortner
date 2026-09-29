// Map database rows to the domain model; SQL lives in the repository.
export function toLink(row) {
  if (!row) return null;
  return {
    code: row.code,
    cursorTimestamp: row.cursor_timestamp,
    originalUrl: row.original_url,
    expiresAt: row.expires_at,
    clicks: Number(row.clicks),
    lastClickedAt: row.last_clicked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
