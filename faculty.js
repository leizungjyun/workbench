import { StudentStore } from './students.js';
import { newFaculty, validateFaculty, facultySummary, facultyProfileFields, facultySearch } from './faculty-model.js';
export class FacultyStore extends StudentStore {
  constructor(notebooks) { super(notebooks, { directory: 'faculty', versionsDirectory: 'faculty-versions', validateDocument: validateFaculty, createDocument: newFaculty, summary: facultySummary, fields: [...facultyProfileFields, 'notes'], label: 'Faculty member' }); }
  async search(query) { return (await this.all()).map(({ document }) => facultySearch(document, query)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)); }
}
