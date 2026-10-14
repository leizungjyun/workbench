import { classesOnDate, teachingDay } from '../timetable-model.js';
import { localDate, shiftDate } from '../daily-model.js';

const element = (tag, text = '', className = '') => {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
};
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const range = values => values.length === 1 ? String(values[0]) : `${values[0]}–${values.at(-1)}`;

function placeCourses(courses) {
  const ends = [];
  return [...courses].sort((a, b) => a.localStart.localeCompare(b.localStart) || a.studentName.localeCompare(b.studentName)).map(course => {
    let lane = ends.findIndex(end => end <= course.localStart);
    if (lane === -1) lane = ends.length;
    ends[lane] = course.localEnd;
    return { ...course, lane };
  });
}

function periodScale(semester, courses) {
  const rows = [];
  const periods = [...semester.periods].sort((a, b) => a.number - b.number);
  for (const period of periods) {
    const start = minutes(period.start), end = minutes(period.end);
    const previous = rows.at(-1);
    if (previous && previous.end < start) {
      const gap = start - previous.end;
      rows.push({ start: previous.end, end: start, height: gap > 60 ? 34 : gap > 15 ? 18 : 4, gap: true });
    }
    const singlePeriod = courses.some(c => c.periods.length === 1 && c.localStart === period.start && c.localEnd === period.end);
    rows.push({ start, end, height: singlePeriod ? 108 : 56, period });
  }
  return rows;
}

function timeScale(courses) {
  const start = Math.min(8 * 60, ...courses.map(c => Math.floor(minutes(c.localStart) / 60) * 60));
  const end = Math.max(22 * 60, ...courses.map(c => Math.ceil(minutes(c.localEnd) / 60) * 60));
  const boundaries = new Set([start, end]);
  for (let time = start; time <= end; time += 30) boundaries.add(time);
  for (const course of courses) { boundaries.add(minutes(course.localStart)); boundaries.add(minutes(course.localEnd)); }
  const sorted = [...boundaries].sort((a, b) => a - b);
  return sorted.slice(0, -1).map((start, i) => ({ start, end: sorted[i + 1], height: (sorted[i + 1] - start) * 1.8 }));
}

function courseDetails(course) {
  const dialog = element('dialog', '', 'timetable-dialog timetable-course-dialog');
  dialog.setAttribute('aria-label', course.name);
  dialog.append(element('h2', course.name));
  const facts = element('dl');
  for (const [label, value] of [
    ['Student', course.studentName], ['Time', `${course.date} · ${course.localStart}–${course.localEnd}`],
    ['School time zone', course.timeZone], ['Periods', course.periods.join(', ')],
    ['Location', course.location || 'Not specified'], ['Course code', course.code || 'Not specified'],
    ['Teaching weeks', course.weeks.join(', ')], ['Week parity', course.parity], ['Notes', course.notes || '—']
  ]) facts.append(element('dt', label), element('dd', value));
  const close = element('button', 'Close'); close.type = 'button'; close.onclick = () => dialog.close();
  dialog.append(facts, close);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog); dialog.showModal(); close.focus();
}

export function renderTimetableWeek({ people, academic, terms, week, semesterId, showWeekends }) {
  const root = element('div', '', 'timetable-visual');
  const activeTerms = terms.filter(s => (!semesterId || s.id === semesterId) && s.startDate <= shiftDate(week, 6) && s.endDate >= week);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = shiftDate(week, index), courses = [], incomplete = [];
    for (const student of people) {
      const result = classesOnDate(student, academic, date, semesterId || undefined);
      courses.push(...result.classes);
      if (result.incomplete) incomplete.push(student.profile.name);
    }
    return { date, index, courses: placeCourses(courses), incomplete };
  });
  const visible = days.filter(day => showWeekends || day.index < 5 || day.courses.length);
  const allCourses = visible.flatMap(day => day.courses);
  const schoolIds = new Set(people.map(s => s.profile.schoolId).filter(Boolean));
  const periodSemester = activeTerms.find(s => s.periods.length && (schoolIds.size === 1 ? schoolIds.has(s.schoolId) : activeTerms.length === 1));
  const usePeriods = periodSemester && allCourses.every(c => c.semesterId === periodSemester.id);
  const rows = usePeriods ? periodScale(periodSemester, allCourses) : timeScale(allCourses);
  const pending = people.flatMap(student => (student.timetables || []).filter(t => activeTerms.some(s => s.id === t.semesterId)).flatMap(t => t.courses.filter(c => c.status === 'pending').map(c => ({ ...c, studentName: student.profile.name }))));
  const incompleteNames = [...new Set(days.flatMap(day => day.incomplete))];
  const caption = element('div', '', 'timetable-caption');
  const dates = `${new Date(`${week}T12:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${new Date(`${shiftDate(week, 6)}T12:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
  caption.append(element('strong', dates));
  if (usePeriods) caption.append(element('span', `${periodSemester.schoolId} · ${periodSemester.name} · ${periodSemester.timeZone}`));
  else caption.append(element('span', 'School-local times · select a student for their period schedule'));
  root.append(caption);
  if (incompleteNames.length) {
    const warning = element('p', `${incompleteNames.join(', ')}: availability incomplete${pending.length ? ` · ${pending.length} course entries pending review` : ''}`, 'timetable-coverage');
    warning.setAttribute('role', 'note'); root.append(warning);
  }

  const scroller = element('div', '', 'timetable-scroll');
  scroller.tabIndex = 0; scroller.setAttribute('role', 'region'); scroller.setAttribute('aria-label', 'Weekly course grid');
  const grid = element('div', '', 'timetable-week');
  const maxLanes = Math.max(1, ...allCourses.map(c => c.lane + 1));
  grid.style.setProperty('--day-count', visible.length);
  const dayWidth = Math.max(158, maxLanes * 138);
  grid.style.setProperty('--day-width', `${dayWidth}px`);
  grid.style.setProperty('--schedule-width', `${92 + visible.length * dayWidth}px`);
  grid.style.setProperty('--schedule-rows', rows.map(row => `${row.height}px`).join(' '));
  const corner = element('div', usePeriods ? 'Period / time' : 'Time', 'timetable-corner'); grid.append(corner);
  const ruler = element('div', '', 'timetable-ruler');
  for (const row of rows) {
    const mark = element('div', '', row.gap ? 'timetable-break' : 'timetable-time');
    if (row.period) mark.append(element('strong', `第${row.period.number}节`), element('span', `${clock(row.start)}–${clock(row.end)}`));
    else if (row.gap && row.height > 20) mark.append(element('span', row.start < 15 * 60 ? 'Lunch break' : 'Evening break'));
    else if (!row.gap && row.start % 30 === 0) mark.append(element('span', clock(row.start)));
    ruler.append(mark);
  }
  ruler.style.gridRow = '2'; ruler.style.gridColumn = '1'; grid.append(ruler);

  for (let column = 0; column < visible.length; column++) {
    const day = visible[column], header = element('div', '', 'timetable-day-heading');
    header.style.gridColumn = String(column + 2); header.style.gridRow = '1';
    if (day.date === localDate()) header.classList.add('timetable-current-day');
    header.append(element('strong', weekdays[day.index]), element('span', new Date(`${day.date}T12:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })));
    for (const term of activeTerms) {
      const teaching = teachingDay(term, day.date), override = term.overrides.find(o => o.date === day.date);
      if (override) header.append(element('small', `${term.schoolId} · Teaches ${weekdays[override.weekday - 1]} (${override.parity})`, 'timetable-makeup'));
      else if (teaching) header.append(element('small', `${activeTerms.length > 1 ? `${term.schoolId} · ` : ''}Week ${teaching.week}`));
    }
    grid.append(header);
    const dayGrid = element('section', '', 'timetable-day');
    dayGrid.setAttribute('aria-label', `${day.date} courses`);
    dayGrid.style.gridColumn = String(column + 2); dayGrid.style.gridRow = '2';
    dayGrid.style.setProperty('--lanes', Math.max(1, ...day.courses.map(c => c.lane + 1)));
    for (const row of rows) dayGrid.append(element('div', '', row.gap ? 'timetable-grid-break' : 'timetable-grid-line'));
    for (const [index, child] of [...dayGrid.children].entries()) { child.style.gridRow = String(index + 1); child.style.gridColumn = '1 / -1'; }
    if (!day.courses.length) { const empty = element('span', 'No confirmed classes', 'timetable-empty-day'); dayGrid.append(empty); }
    for (const course of day.courses) {
      const start = rows.findIndex(row => row.start === minutes(course.localStart));
      const end = rows.findIndex(row => row.end === minutes(course.localEnd));
      if (start < 0 || end < start) continue;
      const block = element('button', '', 'timetable-class-block'); block.type = 'button';
      block.dataset.course = course.id; block.dataset.student = course.studentId;
      block.setAttribute('aria-label', `${course.name} · ${course.studentName} · ${course.localStart}–${course.localEnd}`);
      block.title = `${course.name}\n${course.studentName} · 第${range(course.periods)}节 · ${course.localStart}–${course.localEnd}\n${course.location || 'Location not specified'}`;
      let color = 0; for (const char of `${course.code || course.name}${people.length > 1 ? course.studentId : ''}`) color = (color * 31 + char.charCodeAt(0)) >>> 0;
      block.dataset.color = String(color % 5);
      block.style.gridRow = `${start + 1} / ${end + 2}`; block.style.gridColumn = String(course.lane + 1);
      block.append(element('span', `${course.localStart}–${course.localEnd}`, 'timetable-class-time'), element('strong', course.name, 'timetable-class-name'));
      if (people.length > 1) block.append(element('span', course.studentName, 'timetable-class-student'));
      block.append(element('span', course.location || 'Location not specified', 'timetable-class-location'));
      block.onclick = () => courseDetails(course); dayGrid.append(block);
    }
    grid.append(dayGrid);
  }
  scroller.append(grid); root.append(scroller);
  root.append(element('p', 'Click a course for its full details. On smaller screens, scroll the grid sideways to compare days.', 'timetable-grid-help'));
  if (incompleteNames.length) root.append(element('p', 'Blank cells contain no confirmed classes; pending or missing schedules may still contain busy time.', 'timetable-grid-help'));
  const annotations = activeTerms.flatMap(term => [...term.holidays, ...term.annotations].filter(a => a.start <= shiftDate(week, 6) && a.end >= week).map(a => `${term.schoolId} · ${a.start}–${a.end}: ${a.name}`));
  if (annotations.length) { const notes = element('div', '', 'timetable-week-notes'); notes.append(element('strong', 'This week')); for (const note of annotations) notes.append(element('p', note)); root.append(notes); }
  if (pending.length) {
    const review = element('details', '', 'timetable-pending'); review.append(element('summary', `Pending review · ${pending.length} course entries`));
    for (const course of pending) review.append(element('p', `${course.studentName} · ${course.name}: ${course.notes}`)); root.append(review);
  }
  return root;
}
