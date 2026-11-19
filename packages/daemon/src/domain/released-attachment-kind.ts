// The outer query aliases sessions as `s`. Older release events do not have this evidence.
export const RELEASED_ATTACHMENT_KIND_SQL = `(
  SELECT json_extract(e.payload, '$.releasedAttachmentType') FROM events e
  WHERE e.node_id = s.node_id AND e.type = 'session.detached'
    AND json_extract(e.payload, '$.sessionId') = s.id
    AND json_extract(e.payload, '$.releasedAttachmentType') IN ('tmux', 'external_cli')
  ORDER BY e.seq DESC LIMIT 1
)`;
