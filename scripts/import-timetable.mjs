import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotebookStore } from '../server.js';
import { StudentStore } from '../students.js';
import { TimetableStore } from '../timetables.js';
import { mergeById, validateTimetables, validateStudentTimetables } from '../timetable-model.js';
import { validateStudent } from '../student-model.js';

// Run with the server stopped. Each write uses the normal revision check and backup.
export async function importTimetableFixture(students, timetables, fixture) {
  validateStudentTimetables(fixture.student.timetables);
  const academic = await timetables.read();
  const nextAcademic = {
    ...academic.document,
    schools: mergeById(academic.document.schools, fixture.schools),
    semesters: mergeById(academic.document.semesters, fixture.semesters)
  };
  validateTimetables(nextAcademic);
  let student;
  try { student = await students.read(fixture.student.id); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const matches = (await students.all()).filter(s => s.document.profile.name === fixture.student.name);
    if (matches.length !== 1) throw new Error('Expected one existing student matching this fixture. No student was created.');
    student = matches[0];
  }
  const existing = student.document.timetables || [];
  const imported = fixture.student.timetables.map(t => ({
    ...t,
    courses: mergeById(existing.find(old => old.semesterId === t.semesterId)?.courses || [], t.courses)
  }));
  const nextStudent = {
    ...student.document,
    profile: { ...student.document.profile, schoolId: fixture.student.schoolId },
    timetables: mergeById(existing, imported, 'semesterId')
  };
  validateStudent(nextStudent);
  const academicChanged = JSON.stringify(nextAcademic) !== JSON.stringify(academic.document);
  const studentChanged = JSON.stringify(nextStudent) !== JSON.stringify(student.document);
  if (academicChanged) await timetables.save({ ...academic, document: nextAcademic });
  if (studentChanged) await students.save(student.document.id, { ...student, document: nextStudent });
  return { studentId: student.document.id, academicChanged, studentChanged };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/import-timetable.mjs <input.json> <workspace>');
  const root = path.resolve(process.argv[3]);
  const fixture = JSON.parse(await fs.readFile(path.resolve(process.argv[2]), 'utf8'));
  const notebooks = await new NotebookStore(root).init();
  const students = await new StudentStore(notebooks).init();
  const timetables = await new TimetableStore(notebooks).init();
  students.timetables = timetables;
  console.log(JSON.stringify(await notebooks.serialize(() => importTimetableFixture(students, timetables, fixture))));
}
