import './record-links.css';

export function recordIconLink({ label, href, glyph, icon, flush, notice }) {
  const link = document.createElement('a');
  link.className = 'record-icon-link'; link.href = href;
  link.title = label; link.setAttribute('aria-label', label); link.append(icon(glyph));
  link.onclick = async event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    try { if (await flush()) location.href = link.href; }
    catch (error) { notice(error.message); }
  };
  return link;
}

export function sourceRecordLink(record, options) {
  if (record.facultyId) return recordIconLink({ ...options, label: 'Open faculty member', glyph: 'person', href: `?view=faculty&id=${record.facultyId}` });
  if (record.groupId) return recordIconLink({ ...options, label: 'Open group session', glyph: 'people', href: `?view=group&id=${record.groupId}&session=${record.groupSessionId}` });
  if (record.studentId) return recordIconLink({ ...options, label: 'Open student', glyph: 'person', href: `?view=student&id=${record.studentId}` });
  return null;
}
