/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Data Schema Extractor
 *
 * Extracts data structure definitions across every supported language and ORM.
 * Identifies tables, entities, models, interfaces, and records that carry
 * persistent or regulated data — critical for migration because each schema
 * must be faithfully reproduced in the target technology.
 *
 * ## Coverage
 *
 * | Source Type                   | Language / Tool                                     |
 * |-------------------------------|-----------------------------------------------------|
 * | SQL DDL                       | CREATE TABLE, CREATE VIEW, CREATE PROCEDURE (all DBs)|
 * | COBOL FD / WS Record          | COBOL file descriptions + working-storage group items|
 * | JPA / Hibernate               | Java/Kotlin @Entity, @Table, @Column annotations    |
 * | Spring Data                   | @Document (MongoDB), @RedisHash, @Node (Neo4j)      |
 * | Django ORM                    | Python class inheriting models.Model                |
 * | SQLAlchemy                    | Python class inheriting Base with Column()          |
 * | TypeORM                       | TypeScript @Entity decorator with @Column           |
 * | Prisma                        | `model` blocks in schema.prisma                     |
 * | Pydantic                      | Python BaseModel / BaseSettings subclasses          |
 * | TypeScript Interfaces         | interface declarations with typed fields            |
 * | Protocol Buffers              | message / enum blocks in .proto files               |
 * | Avro                          | "type": "record" in .avsc / .json files             |
 * | ActiveRecord (Ruby)           | Rails migration create_table / column references    |
 * | Doctrine ORM (PHP)            | @ORM\Entity, @ORM\Column annotations               |
 * | GORM (Go)                     | Go struct with `gorm:` tags                         |
 * | Hibernate XML                 | <class name="..."> mapping elements                 |
 * | Mongoose (Node.js)            | new Schema({...}) with typed fields                 |
 * | Sequelize (Node.js)           | DataTypes.STRING / INTEGER field definitions        |
 * | Exposed (Kotlin)              | object inheriting Table / IntIdTable                |
 * | Room (Android)                | @Entity + @ColumnInfo Kotlin/Java annotations       |
 * | Realm (mobile)                | class inheriting RealmObject                        |
 * | Mikro-ORM                     | @Entity decorator (TypeScript)                      |
 * | Drizzle ORM                   | TypeScript schema table definitions                 |
 */

import { IDataSchema, DataSchemaKind } from './discoveryTypes.js';

// ─── Regulated field detection ────────────────────────────────────────────────

/** Field name patterns that suggest regulated / PII data. */
const REGULATED_FIELD_PATTERNS: Array<[RegExp, string]> = [
	[/\b(?:ssn|social_security|social_sec)\b/i,          'SSN (PII/HIPAA)'],
	[/\b(?:credit_card|card_number|cc_num|pan)\b/i,      'Payment card (PCI-DSS)'],
	[/\b(?:iban|account_number|bank_account)\b/i,        'Bank account (PCI-DSS)'],
	[/\b(?:passport|passport_number|passport_no)\b/i,    'Passport number (PII)'],
	[/\b(?:national_id|national_insurance|nino|nin)\b/i, 'National ID (PII)'],
	[/\b(?:dob|date_of_birth|birth_date|birthdate)\b/i,  'Date of birth (PII)'],
	[/\b(?:email|email_address|e_mail)\b/i,              'Email address (PII/GDPR)'],
	[/\b(?:phone|phone_number|mobile|telephone)\b/i,     'Phone number (PII)'],
	[/\b(?:address|street_address|postal_code|zip)\b/i,  'Physical address (PII/GDPR)'],
	[/\b(?:salary|income|wage|earnings)\b/i,             'Financial data (PCI/GDPR)'],
	[/\b(?:health|diagnosis|medical|patient)\b/i,        'Health data (HIPAA)'],
	[/\b(?:biometric|fingerprint_data|retina)\b/i,       'Biometric data (GDPR/HIPAA)'],
	[/\b(?:password|passwd|secret|api_key|token)\b/i,    'Credential (Security)'],
	[/\b(?:gender|race|ethnicity|religion)\b/i,          'Sensitive personal data (GDPR)'],
	[/\b(?:ip_address|device_id|user_id|customer_id)\b/i,'Identifier (GDPR)'],
];

function isFieldRegulated(name: string): { isRegulated: boolean; reason?: string } {
	for (const [re, reason] of REGULATED_FIELD_PATTERNS) {
		if (re.test(name)) { return { isRegulated: true, reason }; }
	}
	return { isRegulated: false };
}


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract data schemas from a unit's source content.
 *
 * @param content   Full source text of the unit (or file)
 * @param unitId    Unit ID to attach schemas to
 * @param lang      Normalised language key
 * @param fileName  File name (helps identify .proto, .prisma, .avsc, etc.)
 */
export function extractDataSchemas(
	content: string,
	unitId: string,
	lang: string,
	fileName: string,
): IDataSchema[] {
	const results: IDataSchema[] = [];

	// Route by language / file type
	switch (lang) {
		case 'cobol':
			extractCobolSchemas(content, unitId, results);
			break;
		case 'sql':
		case 'plsql':
			extractSQLSchemas(content, unitId, results);
			break;
		case 'proto':
			extractProtoSchemas(content, unitId, results);
			break;
		case 'java':
		case 'kotlin':
			extractJVMEntitySchemas(content, unitId, lang, results);
			break;
		case 'scala':
			extractScalaSchemas(content, unitId, results);
			break;
		case 'csharp':
			extractCSharpSchemas(content, unitId, results);
			break;
		case 'python':
			extractPythonSchemas(content, unitId, results);
			break;
		case 'typescript':
		case 'javascript':
			extractNodeSchemas(content, unitId, lang, fileName, results);
			break;
		case 'go':
			extractGoSchemas(content, unitId, results);
			break;
		case 'rust':
			extractRustSchemas(content, unitId, results);
			break;
		case 'ruby':
			extractRubySchemas(content, unitId, results);
			break;
		case 'php':
			extractPhpSchemas(content, unitId, results);
			break;
		case 'elixir':
			extractElixirSchemas(content, unitId, results);
			break;
		case 'haskell':
			extractHaskellSchemas(content, unitId, results);
			break;
	}

	// If this is a Prisma schema file, also scan it
	if (fileName.endsWith('.prisma')) {
		extractPrismaSchemas(content, unitId, results);
	}
	// Avro schema files
	if (fileName.endsWith('.avsc') || (fileName.endsWith('.json') && content.includes('"type": "record"'))) {
		extractAvroSchemas(content, unitId, results);
	}
	// JSON Schema files
	if (fileName.endsWith('.schema.json') || fileName.includes('jsonschema')) {
		extractJsonSchemas(content, unitId, results);
	}
	// Hibernate XML mappings
	if (fileName.endsWith('.hbm.xml') || (lang === 'xml' && content.includes('<class name='))) {
		extractHibernateXMLSchemas(content, unitId, results);
	}

	return results;
}


// ─── COBOL FD / Working-Storage ───────────────────────────────────────────────

function extractCobolSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	const lines = content.split('\n');
	let inFD = false;
	let inWS = false;
	let currentSchema: IDataSchema | null = null;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const col7plus = raw.length >= 7 ? raw.slice(6).trim() : raw.trim();
		const upper = col7plus.toUpperCase();

		// Division transitions
		if (/^FILE\s+SECTION/i.test(upper))              { inFD = true;  inWS = false; continue; }
		if (/^WORKING-STORAGE\s+SECTION/i.test(upper))   { inFD = false; inWS = true;  continue; }
		if (/^LINKAGE\s+SECTION/i.test(upper) ||
		    /^PROCEDURE\s+DIVISION/i.test(upper))         { inFD = false; inWS = false; finishSchema(currentSchema, out); currentSchema = null; continue; }

		// FD entry
		if (inFD) {
			const fd = /^FD\s+([\w-]+)/i.exec(upper);
			if (fd) {
				finishSchema(currentSchema, out);
				currentSchema = makeSchema(unitId, 'cobol-fd', fd[1], i + 1);
				continue;
			}
		}

		// 01-level record in working storage
		if (inWS) {
			const ws01 = /^01\s+([\w-]+)/i.exec(upper);
			if (ws01 && !ws01[1].toUpperCase().startsWith('FILLER')) {
				finishSchema(currentSchema, out);
				currentSchema = makeSchema(unitId, 'cobol-working-storage-record', ws01[1], i + 1);
				continue;
			}
		}

		// Field: 05-49 level
		if (currentSchema) {
			const field = /^(\d+)\s+([\w-]+)\s+PIC\s+([X9A][^\s.]*)/i.exec(upper);
			if (field && parseInt(field[1]) >= 5) {
				const name = field[2];
				if (name.toUpperCase() === 'FILLER') { continue; }
				const pic = field[3].toUpperCase();
				const dtype = pic.startsWith('9') ? 'NUMERIC' : pic.startsWith('X') ? 'ALPHANUMERIC' : 'ALPHA';
				const reg = isFieldRegulated(name);
				currentSchema.fields.push({
					name, dataType: dtype, nullable: false,
					isPrimaryKey: false, isForeignKey: false,
					isRegulated: reg.isRegulated, regulatedReason: reg.reason,
				});
				if (reg.isRegulated) { currentSchema.hasRegulatedFields = true; }
			}
		}
	}
	finishSchema(currentSchema, out);
}


// ─── SQL DDL (all dialects) ───────────────────────────────────────────────────

function extractSQLSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	const lines = content.split('\n');
	let inCreate = false;
	let currentSchema: IDataSchema | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const upper = line.trim().toUpperCase();

		// CREATE TABLE / VIEW
		if (!inCreate) {
			const ct = /CREATE\s+(?:TEMPORARY\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)/i.exec(line);
			if (ct) {
				finishSchema(currentSchema, out);
				const kind: DataSchemaKind = /VIEW/i.test(ct[0]) ? 'sql-view' : 'sql-table';
				const name = ct[1].replace(/[`"[\]]/g, '').split('.').pop() ?? ct[1];
				currentSchema = makeSchema(unitId, kind, name, i + 1);
				if (line.includes('(')) { inCreate = true; }
				continue;
			}
			// CREATE PROCEDURE / FUNCTION
			const cp = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION)\s+([\w.]+)/i.exec(line);
			if (cp) {
				out.push(makeSchema(unitId, 'sql-procedure', cp[1], i + 1));
				continue;
			}
		}

		if (inCreate && currentSchema) {
			// End of statement
			if (upper.startsWith(');') || upper === ')') {
				inCreate = false;
				finishSchema(currentSchema, out);
				currentSchema = null;
				continue;
			}

			// Column definition: name type [NOT NULL] [PRIMARY KEY] [REFERENCES]
			const col = /^\s*([`"[\w]+)\s+((?:VARCHAR|CHAR|NVARCHAR|NCHAR|TEXT|CLOB|BLOB|INT|INTEGER|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|BOOLEAN|BOOL|DATE|DATETIME|TIMESTAMP|TIME|UUID|JSON|JSONB|BYTEA|BINARY|VARBINARY)[\w(,)]*)/i.exec(line);
			if (col) {
				const colName = col[1].replace(/[`"[\]]/g, '');
				if (/CONSTRAINT|PRIMARY\s+KEY|UNIQUE|INDEX|KEY\s+/i.test(line) && !/^\s*[`"[\w]+\s+/i.test(line)) { continue; }
				const isPrimary = /PRIMARY\s+KEY/i.test(line);
				const isForeign = /REFERENCES/i.test(line);
				const isNullable = !/NOT\s+NULL/i.test(line);
				const maxLen = /\((\d+)(?:,(\d+))?\)/.exec(col[2]);
				const reg = isFieldRegulated(colName);
				currentSchema.fields.push({
					name: colName, dataType: col[2].toUpperCase(),
					nullable: isNullable, isPrimaryKey: isPrimary, isForeignKey: isForeign,
					maxLength: maxLen ? parseInt(maxLen[1]) : undefined,
					precision: maxLen?.[2] ? parseInt(maxLen[1]) : undefined,
					scale: maxLen?.[2] ? parseInt(maxLen[2]) : undefined,
					isRegulated: reg.isRegulated, regulatedReason: reg.reason,
				});
				if (reg.isRegulated) { currentSchema.hasRegulatedFields = true; }
			}
		}
	}
	finishSchema(currentSchema, out);
}


// ─── Protocol Buffers ─────────────────────────────────────────────────────────

function extractProtoSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	const lines = content.split('\n');
	let currentSchema: IDataSchema | null = null;
	let depth = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// message or enum block
		const msg = /^(?:message|enum)\s+(\w+)\s*\{/.exec(line);
		if (msg && depth === 0) {
			finishSchema(currentSchema, out);
			currentSchema = makeSchema(unitId, 'proto-message', msg[1], i + 1);
			depth = 1;
			continue;
		}

		if (currentSchema) {
			for (const ch of line) {
				if (ch === '{') { depth++; }
				if (ch === '}') { depth--; }
			}
			if (depth <= 0) {
				finishSchema(currentSchema, out);
				currentSchema = null;
				depth = 0;
				continue;
			}

			// Field: [repeated/optional/required] type name = number;
			const field = /^(?:repeated\s+|optional\s+|required\s+)?([\w.]+)\s+(\w+)\s*=\s*\d+/.exec(line);
			if (field && !/^\/\//.test(line)) {
				const reg = isFieldRegulated(field[2]);
				currentSchema.fields.push({
					name: field[2], dataType: field[1],
					nullable: true, isPrimaryKey: false, isForeignKey: false,
					isRegulated: reg.isRegulated, regulatedReason: reg.reason,
				});
				if (reg.isRegulated) { currentSchema.hasRegulatedFields = true; }
			}
		}
	}
}


// ─── JVM JPA / Hibernate / Spring Data / Room ─────────────────────────────────

function extractJVMEntitySchemas(content: string, unitId: string, lang: string, out: IDataSchema[]): void {
	// Check if this is an @Entity class
	if (!/\@Entity\b/.test(content) &&
	    !/\@Document\b/.test(content) &&
	    !/\@RedisHash\b/.test(content) &&
	    !/\@Table\b/.test(content)) { return; }

	// Extract class name
	const classRe = lang === 'kotlin'
		? /(?:data\s+)?class\s+(\w+)/
		: /class\s+(\w+)/;
	const classMat = classRe.exec(content);
	if (!classMat) { return; }

	const schema = makeSchema(unitId, 'jpa-entity', classMat[1], 1);

	// For @Column fields — scan each field/property
	const lines = content.split('\n');
	let pendingColumn = false;
	let isPrimary = false;
	let isForeign = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (/@Id\b/.test(line))         { isPrimary = true; }
		if (/@ManyToOne|@OneToOne|@JoinColumn/.test(line)) { isForeign = true; }
		if (/@Column\b|@ColumnInfo\b/.test(line)) { pendingColumn = true; }

		if (pendingColumn || isPrimary) {
			// Java: private String firstName;
			// Kotlin: val firstName: String
			let fieldMatch: RegExpExecArray | null = null;
			if (lang === 'kotlin') {
				fieldMatch = /(?:val|var)\s+(\w+)\s*:\s*([\w?<>]+)/.exec(line);
			} else {
				fieldMatch = /(?:private|protected|public)?\s+(\w+)\s+(\w+)\s*[;=]/.exec(line);
				if (fieldMatch) { [fieldMatch[1], fieldMatch[2]] = [fieldMatch[2], fieldMatch[1]]; }
			}

			if (fieldMatch) {
				const fieldName = fieldMatch[1];
				const fieldType = fieldMatch[2] ?? 'unknown';
				if (!isJavaKeyword(fieldName)) {
					const reg = isFieldRegulated(fieldName);
					schema.fields.push({
						name: fieldName, dataType: fieldType,
						nullable: fieldType.endsWith('?') || fieldType === 'Optional',
						isPrimaryKey: isPrimary, isForeignKey: isForeign,
						isRegulated: reg.isRegulated, regulatedReason: reg.reason,
					});
					if (reg.isRegulated) { schema.hasRegulatedFields = true; }
				}
				pendingColumn = false;
				isPrimary = false;
				isForeign = false;
			}
		}
	}

	out.push(schema);
}


// ─── Scala (case classes, Slick Tables) ───────────────────────────────────────

function extractScalaSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	// Case classes (common DTO/entity pattern in Scala)
	const caseClass = /case\s+class\s+(\w+)\s*\(([^)]+)\)/g;
	let m: RegExpExecArray | null;
	while ((m = caseClass.exec(content)) !== null) {
		const schema = makeSchema(unitId, 'typescript-interface', m[1], lineOf(content, m.index));
		const params = m[2].split(',');
		for (const param of params) {
			const pMatch = /(\w+)\s*:\s*([\w\[\],.? ]+)/.exec(param.trim());
			if (pMatch) {
				const reg = isFieldRegulated(pMatch[1]);
				schema.fields.push({
					name: pMatch[1], dataType: pMatch[2].trim(),
					nullable: pMatch[2].includes('Option'), isPrimaryKey: false, isForeignKey: false,
					isRegulated: reg.isRegulated, regulatedReason: reg.reason,
				});
				if (reg.isRegulated) { schema.hasRegulatedFields = true; }
			}
		}
		out.push(schema);
	}

	// Slick Table definitions
	if (/class\s+\w+Table/.test(content) && /\*\s*=/.test(content)) {
		// Slick table columns: def columnName = column[Type]("db_name")
		const colRe = /def\s+(\w+)\s*=\s*column\[([^\]]+)\]\s*\(\s*"([^"]+)"/g;
		const tableName = /class\s+(\w+)Table/.exec(content)?.[1] ?? 'SlickTable';
		const schema = makeSchema(unitId, 'sql-table', tableName, 1);
		let cm: RegExpExecArray | null;
		while ((cm = colRe.exec(content)) !== null) {
			const reg = isFieldRegulated(cm[1]);
			schema.fields.push({
				name: cm[1], dataType: cm[2],
				nullable: cm[2].includes('Option'), isPrimaryKey: false, isForeignKey: false,
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}


// ─── C# (EF Core / Dapper / ADO.NET) ─────────────────────────────────────────

function extractCSharpSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	// Check for EF attributes
	const isEntity = /\[Table\b|\[Entity\b|\[Key\b|\bDbSet</.test(content);
	if (!isEntity) {
		// Plain record / class with properties (DTO)
		if (!/public\s+(?:record|class)\s+\w+/.test(content)) { return; }
	}

	const classRe = /public\s+(?:partial\s+)?(?:record|class)\s+(\w+)/g;
	let cm: RegExpExecArray | null;
	while ((cm = classRe.exec(content)) !== null) {
		const schema = makeSchema(unitId, isEntity ? 'jpa-entity' : 'typescript-interface', cm[1], lineOf(content, cm.index));
		// Scan properties within the class body
		const body = extractBraceBody(content, cm.index);
		const propRe = /public\s+([\w<>?\[\]]+)\s+(\w+)\s*(?:\{|=|;)/g;
		let pm: RegExpExecArray | null;
		while ((pm = propRe.exec(body)) !== null) {
			const fieldName = pm[2];
			const fieldType = pm[1];
			if (!isCSharpKeyword(fieldName) && fieldName !== 'get' && fieldName !== 'set') {
				const reg = isFieldRegulated(fieldName);
				schema.fields.push({
					name: fieldName, dataType: fieldType,
					nullable: fieldType.endsWith('?'), isPrimaryKey: /\[Key\]/.test(body),
					isForeignKey: /\[ForeignKey/.test(body),
					isRegulated: reg.isRegulated, regulatedReason: reg.reason,
				});
				if (reg.isRegulated) { schema.hasRegulatedFields = true; }
			}
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}


// ─── Python: Django / SQLAlchemy / Pydantic / dataclass ───────────────────────

function extractPythonSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	const lines = content.split('\n');
	let currentClass: { name: string; base: string; line: number } | null = null;
	let currentSchema: IDataSchema | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Class declaration
		const classMat = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/.exec(trimmed);
		if (classMat) {
			// Finish previous
			if (currentSchema) { finishSchema(currentSchema, out); currentSchema = null; }
			const base = classMat[2].trim();
			currentClass = { name: classMat[1], base, line: i + 1 };

			if (/models\.Model|Model\s*$/.test(base)) {
				currentSchema = makeSchema(unitId, 'django-model', classMat[1], i + 1);
			} else if (/Base\s*$|DeclarativeBase|db\.Model/.test(base)) {
				currentSchema = makeSchema(unitId, 'sqlalchemy-model', classMat[1], i + 1);
			} else if (/BaseModel|BaseSettings|RootModel/.test(base)) {
				currentSchema = makeSchema(unitId, 'pydantic-model', classMat[1], i + 1);
			} else if (/@dataclass/.test(lines[i - 1] ?? '') || /TypedDict/.test(base)) {
				currentSchema = makeSchema(unitId, 'typescript-interface', classMat[1], i + 1);
			}
			continue;
		}

		// New top-level def / class \u2192 end previous class
		if (/^\S/.test(line) && trimmed !== '' && !trimmed.startsWith('#')) {
			if (currentSchema) { finishSchema(currentSchema, out); currentSchema = null; }
			currentClass = null;
		}

		if (!currentSchema || !currentClass) { continue; }

		// ── Django field: field_name = models.CharField(...) ──────────────
		if (currentSchema.kind === 'django-model') {
			const dfm = /^\s+(\w+)\s*=\s*models\.([\w]+)\s*\(([^)]*)\)/.exec(line);
			if (dfm) {
				const fieldName = dfm[1];
				const fieldType = dfm[2];
				const args = dfm[3];
				const isPrimary = /primary_key\s*=\s*True/.test(args);
				const isNullable = /null\s*=\s*True/.test(args);
				const reg = isFieldRegulated(fieldName);
				currentSchema.fields.push({
					name: fieldName, dataType: fieldType,
					nullable: isNullable, isPrimaryKey: isPrimary, isForeignKey: /ForeignKey|OneToOne/.test(fieldType),
					isRegulated: reg.isRegulated, regulatedReason: reg.reason,
				});
				if (reg.isRegulated) { currentSchema.hasRegulatedFields = true; }
			}
		}

		// ── SQLAlchemy: field_name = Column(Type, ...) ────────────────────
		if (currentSchema.kind === 'sqlalchemy-model') {
			const sam = /^\s+(\w+)\s*(?::\s*Mapped\[([^\]]+)\])?\s*=\s*(?:mapped_column|Column)\s*\(([^)]*)\)/.exec(line);
			if (sam) {
				const fieldName = sam[1];
				const args = sam[3];
				const typeM = /(String|Integer|Float|Boolean|DateTime|Date|Text|JSON|UUID|Numeric|BigInteger)\b/.exec(args);
				const isPrimary = /primary_key\s*=\s*True/.test(args);
				const reg = isFieldRegulated(fieldName);
				currentSchema.fields.push({
					name: fieldName, dataType: typeM?.[1] ?? sam[2] ?? 'Any',
					nullable: /nullable\s*=\s*True/.test(args),
					isPrimaryKey: isPrimary, isForeignKey: /ForeignKey/.test(args),
					isRegulated: reg.isRegulated, regulatedReason: reg.reason,
				});
				if (reg.isRegulated) { currentSchema.hasRegulatedFields = true; }
			}
		}

		// ── Pydantic: field_name: Type = Field(...) / field_name: Type ────
		if (currentSchema.kind === 'pydantic-model' || currentSchema.kind === 'typescript-interface') {
			const pym = /^\s+(\w+)\s*:\s*([\w\[\]| ,?Optional]+?)(?:\s*=.*)?$/.exec(line);
			if (pym && pym[1] !== 'class' && pym[1] !== 'def' && !pym[1].startsWith('__')) {
				const reg = isFieldRegulated(pym[1]);
				currentSchema.fields.push({
					name: pym[1], dataType: pym[2].trim(),
					nullable: /Optional|None/.test(pym[2]),
					isPrimaryKey: false, isForeignKey: false,
					isRegulated: reg.isRegulated, regulatedReason: reg.reason,
				});
				if (reg.isRegulated) { currentSchema.hasRegulatedFields = true; }
			}
		}
	}
	if (currentSchema) { finishSchema(currentSchema, out); }
}


// ─── TypeScript / JavaScript (interfaces, TypeORM, Mongoose, Sequelize, Drizzle) ──

function extractNodeSchemas(content: string, unitId: string, lang: string, fileName: string, out: IDataSchema[]): void {
	// TypeScript interfaces
	extractTSInterfaces(content, unitId, out);
	// TypeORM @Entity
	if (/@Entity\b/.test(content)) { extractTypeORMSchemas(content, unitId, out); }
	// Mongoose Schema
	if (/new\s+Schema\s*\(/.test(content)) { extractMongooseSchemas(content, unitId, out); }
	// Sequelize Model.define or class extends Model
	if (/\bSequelize\b|DataTypes\b/.test(content)) { extractSequelizeSchemas(content, unitId, out); }
	// Mikro-ORM
	if (/@Entity\b/.test(content) && /@Property\b/.test(content)) { /* handled by TypeORM extractor */ }
	// Drizzle ORM: pgTable / mysqlTable / sqliteTable
	const drizzle = /(?:pgTable|mysqlTable|sqliteTable|sqliteView|pgView)\s*\(\s*["']([^"']+)["']/g;
	let dm: RegExpExecArray | null;
	while ((dm = drizzle.exec(content)) !== null) {
		const schema = makeSchema(unitId, 'sql-table', dm[1], lineOf(content, dm.index));
		// Extract column definitions within the table block
		const body = extractBraceBody(content, dm.index + dm[0].length - 1);
		const colRe = /(\w+):\s*(?:integer|text|varchar|boolean|timestamp|uuid|json|real|numeric|serial|bigint)\s*\(/gi;
		let cm: RegExpExecArray | null;
		while ((cm = colRe.exec(body)) !== null) {
			const reg = isFieldRegulated(cm[1]);
			schema.fields.push({ name: cm[1], dataType: cm[0].split(':')[1]?.trim().split('(')[0] ?? 'unknown', nullable: true, isPrimaryKey: false, isForeignKey: false, isRegulated: reg.isRegulated, regulatedReason: reg.reason });
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}

function extractTSInterfaces(content: string, unitId: string, out: IDataSchema[]): void {
	const intRe = /(?:export\s+)?(?:interface|type)\s+(\w+)\s*(?:extends\s+[^{]+)?\s*=?\s*\{/g;
	let m: RegExpExecArray | null;
	while ((m = intRe.exec(content)) !== null) {
		const schema = makeSchema(unitId, 'typescript-interface', m[1], lineOf(content, m.index));
		const body = extractBraceBody(content, m.index + m[0].length - 1);
		const fieldRe = /(\w+)\??\s*:\s*([\w<>\[\]|&\s,.'"`]+?)(?:;|\n)/g;
		let fm: RegExpExecArray | null;
		while ((fm = fieldRe.exec(body)) !== null) {
			if (/^(?:new|readonly|static|get|set|abstract)$/.test(fm[1])) { continue; }
			const reg = isFieldRegulated(fm[1]);
			schema.fields.push({
				name: fm[1], dataType: fm[2].trim(),
				nullable: fm[0].includes('?') || /undefined|null/.test(fm[2]),
				isPrimaryKey: false, isForeignKey: false,
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}

function extractTypeORMSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	const classRe = /class\s+(\w+)/g;
	let cm: RegExpExecArray | null;
	while ((cm = classRe.exec(content)) !== null) {
		const schema = makeSchema(unitId, 'typeorm-entity', cm[1], lineOf(content, cm.index));
		// @Column() / @PrimaryGeneratedColumn() / @CreateDateColumn() / @UpdateDateColumn()
		const colRe = /@(?:Column|PrimaryGenerated|PrimaryColumn|CreateDate|UpdateDate|DeleteDate|Version|Generated)Column\s*(?:\([^)]*\))?\s*\n\s*(\w+)\s*[!?]?\s*:\s*([\w<>[\]| ]+)/g;
		let fm: RegExpExecArray | null;
		while ((fm = colRe.exec(content)) !== null) {
			const reg = isFieldRegulated(fm[1]);
			schema.fields.push({
				name: fm[1], dataType: fm[2].trim(),
				nullable: /@Column\([^)]*nullable:\s*true/.test(fm[0]),
				isPrimaryKey: /Primary/.test(fm[0]), isForeignKey: false,
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}

function extractMongooseSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	const schemaRe = /(?:const|let|var)\s+(\w+)\s*=\s*new\s+Schema\s*\(\s*\{/g;
	let m: RegExpExecArray | null;
	while ((m = schemaRe.exec(content)) !== null) {
		const name = m[1].replace(/[Ss]chema$/, '');
		const schema = makeSchema(unitId, 'typeorm-entity', name, lineOf(content, m.index));
		const body = extractBraceBody(content, m.index + m[0].length - 1);
		const fieldRe = /(\w+)\s*:\s*(?:\{[^}]*type\s*:\s*(\w+)|(\w+))/g;
		let fm: RegExpExecArray | null;
		while ((fm = fieldRe.exec(body)) !== null) {
			const fieldName = fm[1];
			if (['_id', '__v'].includes(fieldName)) { continue; }
			const reg = isFieldRegulated(fieldName);
			schema.fields.push({
				name: fieldName, dataType: fm[2] ?? fm[3] ?? 'Mixed',
				nullable: true, isPrimaryKey: fieldName === '_id',
				isForeignKey: /ObjectId/.test(fm[2] ?? ''),
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}

function extractSequelizeSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	// Model.define("tableName", { field: DataTypes.STRING })
	const defRe = /\.define\s*\(\s*["'](\w+)["']\s*,\s*\{/g;
	let m: RegExpExecArray | null;
	while ((m = defRe.exec(content)) !== null) {
		const schema = makeSchema(unitId, 'typeorm-entity', m[1], lineOf(content, m.index));
		const body = extractBraceBody(content, m.index + m[0].length - 1);
		const fieldRe = /(\w+)\s*:\s*(?:\{[^}]*type\s*:\s*DataTypes\.(\w+)|DataTypes\.(\w+))/g;
		let fm: RegExpExecArray | null;
		while ((fm = fieldRe.exec(body)) !== null) {
			const reg = isFieldRegulated(fm[1]);
			schema.fields.push({
				name: fm[1], dataType: `DataTypes.${fm[2] ?? fm[3]}`,
				nullable: true, isPrimaryKey: false, isForeignKey: false,
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}


// ─── Go Structs (with GORM/db tags) ──────────────────────────────────────────

function extractGoSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	const structRe = /type\s+(\w+)\s+struct\s*\{/g;
	let m: RegExpExecArray | null;
	while ((m = structRe.exec(content)) !== null) {
		const schema = makeSchema(unitId, 'jpa-entity', m[1], lineOf(content, m.index));
		const body = extractBraceBody(content, m.index + m[0].length - 1);

		// Go struct field: FieldName Type `json:"..." gorm:"column:..."`
		const fieldRe = /^\s+(\w+)\s+([\w.*\[\]]+)(?:\s+`([^`]*)`)?/gm;
		let fm: RegExpExecArray | null;
		while ((fm = fieldRe.exec(body)) !== null) {
			const fieldName = fm[1];
			if (fieldName === '}') { break; }
			const reg = isFieldRegulated(fieldName);
			// Check for gorm primaryKey tag
			const isPrimary = /gorm:"[^"]*primaryKey/.test(fm[3] ?? '');
			schema.fields.push({
				name: fieldName, dataType: fm[2],
				nullable: fm[2].startsWith('*'),
				isPrimaryKey: isPrimary, isForeignKey: false,
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}


// ─── Rust (Diesel / SeaORM / SQLx structs) ────────────────────────────────────

function extractRustSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	// Structs with #[derive(...)] annotations that suggest DB entities
	const lines = content.split('\n');
	let inDerive = false;
	let isEntity = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (/#\[derive\(/.test(line)) { inDerive = true; isEntity = false; }
		if (inDerive && /Queryable|Insertable|AsChangeset|Entity|FromRow|sea_orm/.test(line)) { isEntity = true; }

		const structM = /^(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+(\w+)/.exec(line);
		if (structM) {
			inDerive = false;
			if (!isEntity) { continue; }
			const schema = makeSchema(unitId, 'jpa-entity', structM[1], i + 1);
			// Scan subsequent lines for fields
			let j = i + 1;
			let braceOpen = line.includes('{');
			if (braceOpen) {
				while (j < lines.length) {
					const fl = lines[j].trim();
					if (fl === '}') { break; }
					const fieldM = /^(?:pub\s+)?(\w+)\s*:\s*([\w<>()]+)/.exec(fl);
					if (fieldM) {
						const reg = isFieldRegulated(fieldM[1]);
						schema.fields.push({
							name: fieldM[1], dataType: fieldM[2],
							nullable: fieldM[2].startsWith('Option'),
							isPrimaryKey: false, isForeignKey: false,
							isRegulated: reg.isRegulated, regulatedReason: reg.reason,
						});
						if (reg.isRegulated) { schema.hasRegulatedFields = true; }
					}
					j++;
				}
			}
			if (schema.fields.length > 0) { out.push(schema); }
			isEntity = false;
		}
	}
}


// ─── Ruby ActiveRecord ────────────────────────────────────────────────────────

function extractRubySchemas(content: string, unitId: string, out: IDataSchema[]): void {
	// Rails migrations: create_table :users do |t|  t.string :name
	const migRe = /create_table\s+:(\w+)/g;
	let m: RegExpExecArray | null;
	while ((m = migRe.exec(content)) !== null) {
		const schema = makeSchema(unitId, 'sql-table', m[1], lineOf(content, m.index));
		const body = extractBraceBody(content, m.index + m[0].length);
		const colRe = /t\.(string|integer|text|boolean|datetime|float|decimal|references|bigint|binary|date|time|json|uuid)\s+:(\w+)/g;
		let cm: RegExpExecArray | null;
		while ((cm = colRe.exec(body)) !== null) {
			const reg = isFieldRegulated(cm[2]);
			schema.fields.push({
				name: cm[2], dataType: cm[1],
				nullable: true, isPrimaryKey: false, isForeignKey: cm[1] === 'references',
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}

	// ActiveRecord class: class User < ApplicationRecord with attr_accessor / scope
	const classRe = /class\s+(\w+)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)/g;
	while ((m = classRe.exec(content)) !== null) {
		const schema = makeSchema(unitId, 'jpa-entity', m[1], lineOf(content, m.index));
		// attr_accessor / validates presence hints at fields
		const attrRe = /attr_(?:accessor|reader|writer)\s+:(\w+)/g;
		let am: RegExpExecArray | null;
		while ((am = attrRe.exec(content)) !== null) {
			const reg = isFieldRegulated(am[1]);
			schema.fields.push({
				name: am[1], dataType: 'String',
				nullable: true, isPrimaryKey: false, isForeignKey: false,
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}


// ─── PHP Doctrine ─────────────────────────────────────────────────────────────

function extractPhpSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	if (!/@ORM\\Entity|#\[ORM\\Entity\]|@Entity/.test(content)) { return; }

	const classRe = /class\s+(\w+)/g;
	let m: RegExpExecArray | null;
	while ((m = classRe.exec(content)) !== null) {
		const schema = makeSchema(unitId, 'jpa-entity', m[1], lineOf(content, m.index));
		// @ORM\Column(type="string") / #[ORM\Column(type: 'string')]
		const colRe = /@(?:ORM\\)?Column\s*\(\s*(?:type\s*[=:]\s*["']?(\w+)["']?)?\s*[,)][^]*?(?:private|protected|public)\s+(?:\$|\?)?([\w]+)/g;
		let cm: RegExpExecArray | null;
		while ((cm = colRe.exec(content)) !== null) {
			const reg = isFieldRegulated(cm[2]);
			schema.fields.push({
				name: cm[2], dataType: cm[1] ?? 'string',
				nullable: /nullable\s*[=:]\s*true/.test(cm[0]),
				isPrimaryKey: /@(?:ORM\\)?Id\b/.test(cm[0]),
				isForeignKey: /@(?:ORM\\)?JoinColumn/.test(cm[0]),
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}


// ─── Elixir Ecto ──────────────────────────────────────────────────────────────

function extractElixirSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	// schema "table_name" do ... field :name, :type ... end
	const schemaRe = /schema\s+"(\w+)"\s+do([\s\S]*?)end/g;
	let m: RegExpExecArray | null;
	while ((m = schemaRe.exec(content)) !== null) {
		const schema = makeSchema(unitId, 'jpa-entity', m[1], lineOf(content, m.index));
		const body = m[2];
		const fieldRe = /field\s+:(\w+)\s*,\s*:(\w+)/g;
		let fm: RegExpExecArray | null;
		while ((fm = fieldRe.exec(body)) !== null) {
			const reg = isFieldRegulated(fm[1]);
			schema.fields.push({
				name: fm[1], dataType: fm[2],
				nullable: true, isPrimaryKey: false, isForeignKey: false,
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}


// ─── Haskell Persistent ───────────────────────────────────────────────────────

function extractHaskellSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	// Persistent QuasiQuote: [persistLowerCase| User  name Text  age Int  |]
	const persistRe = /\[persist\w+\|([\s\S]*?)\|]/g;
	let m: RegExpExecArray | null;
	while ((m = persistRe.exec(content)) !== null) {
		const body = m[1];
		let currentSchema: IDataSchema | null = null;
		for (const line of body.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('--')) { continue; }
			// Entity declaration: no leading whitespace
			if (/^\w/.test(trimmed) && !/^\s/.test(line)) {
				if (currentSchema) { out.push(currentSchema); }
				currentSchema = makeSchema(unitId, 'jpa-entity', trimmed.split(/\s/)[0], lineOf(content, m.index));
			} else if (currentSchema) {
				const fieldM = /(\w+)\s+([\w]+)/.exec(trimmed);
				if (fieldM) {
					const reg = isFieldRegulated(fieldM[1]);
					currentSchema.fields.push({
						name: fieldM[1], dataType: fieldM[2],
						nullable: fieldM[2].endsWith('Maybe'), isPrimaryKey: false, isForeignKey: false,
						isRegulated: reg.isRegulated, regulatedReason: reg.reason,
					});
					if (reg.isRegulated) { currentSchema.hasRegulatedFields = true; }
				}
			}
		}
		if (currentSchema) { out.push(currentSchema); }
	}
}


// ─── Prisma Schema ────────────────────────────────────────────────────────────

function extractPrismaSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	const modelRe = /^model\s+(\w+)\s*\{/gm;
	let m: RegExpExecArray | null;
	while ((m = modelRe.exec(content)) !== null) {
		const schema = makeSchema(unitId, 'prisma-model', m[1], lineOf(content, m.index));
		const body = extractBraceBody(content, m.index + m[0].length - 1);
		const fieldRe = /^\s+(\w+)\s+([\w\[\]?!]+)(?:\s+@[^\n]*)?\s*$/gm;
		let fm: RegExpExecArray | null;
		while ((fm = fieldRe.exec(body)) !== null) {
			const fieldName = fm[1];
			if (['@@', '//'].some(p => fieldName.startsWith(p))) { continue; }
			const reg = isFieldRegulated(fieldName);
			schema.fields.push({
				name: fieldName, dataType: fm[2].replace(/[?!]/, ''),
				nullable: fm[2].endsWith('?'),
				isPrimaryKey: fm[0].includes('@id'),
				isForeignKey: false,
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}


// ─── Avro Schema ──────────────────────────────────────────────────────────────

function extractAvroSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	try {
		const parsed = JSON.parse(content);
		const records = Array.isArray(parsed) ? parsed : [parsed];
		for (const rec of records) {
			if (rec.type !== 'record' || !rec.name) { continue; }
			const schema = makeSchema(unitId, 'avro-schema', rec.name, 1);
			for (const field of (rec.fields ?? [])) {
				const reg = isFieldRegulated(field.name);
				const typ = Array.isArray(field.type)
					? field.type.filter((t: unknown) => t !== 'null').join('|')
					: String(field.type);
				schema.fields.push({
					name: field.name, dataType: typ,
					nullable: Array.isArray(field.type) && field.type.includes('null'),
					isPrimaryKey: false, isForeignKey: false,
					isRegulated: reg.isRegulated, regulatedReason: reg.reason,
				});
				if (reg.isRegulated) { schema.hasRegulatedFields = true; }
			}
			if (schema.fields.length > 0) { out.push(schema); }
		}
	} catch { /* not valid JSON — skip */ }
}


// ─── JSON Schema ──────────────────────────────────────────────────────────────

function extractJsonSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	try {
		const parsed = JSON.parse(content);
		if (parsed.type !== 'object' && !parsed.properties) { return; }
		const title = parsed.title ?? parsed.$id ?? 'JsonSchema';
		const schema = makeSchema(unitId, 'json-schema-object', title, 1);
		for (const [name, def] of Object.entries(parsed.properties ?? {})) {
			const d = def as Record<string, unknown>;
			const reg = isFieldRegulated(name);
			schema.fields.push({
				name, dataType: String(d.type ?? 'any'),
				nullable: !Array.isArray(parsed.required) || !parsed.required.includes(name),
				isPrimaryKey: false, isForeignKey: false,
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	} catch { /* not valid JSON */ }
}


// ─── Hibernate XML ────────────────────────────────────────────────────────────

function extractHibernateXMLSchemas(content: string, unitId: string, out: IDataSchema[]): void {
	const classRe = /<class\s[^>]*name="([^"]+)"/g;
	let m: RegExpExecArray | null;
	while ((m = classRe.exec(content)) !== null) {
		const simpleName = m[1].split('.').pop() ?? m[1];
		const schema = makeSchema(unitId, 'jpa-entity', simpleName, lineOf(content, m.index));
		const propRe = /<property\s[^>]*name="([^"]+)"[^>]*type="([^"]+)"/g;
		let pm: RegExpExecArray | null;
		while ((pm = propRe.exec(content)) !== null) {
			const reg = isFieldRegulated(pm[1]);
			schema.fields.push({
				name: pm[1], dataType: pm[2],
				nullable: true, isPrimaryKey: false, isForeignKey: false,
				isRegulated: reg.isRegulated, regulatedReason: reg.reason,
			});
			if (reg.isRegulated) { schema.hasRegulatedFields = true; }
		}
		if (schema.fields.length > 0) { out.push(schema); }
	}
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSchema(unitId: string, kind: DataSchemaKind, name: string, lineNumber: number): IDataSchema {
	return { unitId, kind, name, fields: [], hasRegulatedFields: false, lineNumber };
}

function finishSchema(schema: IDataSchema | null, out: IDataSchema[]): void {
	if (schema && schema.fields.length > 0) { out.push(schema); }
}

function lineOf(content: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) {
		if (content[i] === '\n') { line++; }
	}
	return line;
}

/** Extract the content between the first `{` at or after `startIndex` and its matching `}`. */
function extractBraceBody(content: string, startIndex: number): string {
	let depth = 0;
	let start = -1;
	for (let i = startIndex; i < content.length; i++) {
		if (content[i] === '{') {
			if (depth === 0) { start = i + 1; }
			depth++;
		}
		if (content[i] === '}') {
			depth--;
			if (depth === 0 && start !== -1) {
				return content.slice(start, i);
			}
		}
	}
	return start !== -1 ? content.slice(start) : '';
}

const JAVA_KEYWORDS = new Set([
	'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
	'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
	'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
	'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
	'package', 'private', 'protected', 'public', 'return', 'short', 'static',
	'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
	'transient', 'try', 'void', 'volatile', 'while',
]);
function isJavaKeyword(w: string): boolean { return JAVA_KEYWORDS.has(w); }

const CSHARP_KEYWORDS = new Set([
	'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char',
	'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate',
	'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false',
	'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit',
	'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace',
	'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private',
	'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed',
	'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch',
	'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked',
	'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
]);
function isCSharpKeyword(w: string): boolean { return CSHARP_KEYWORDS.has(w); }
