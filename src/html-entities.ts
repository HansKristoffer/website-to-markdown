/**
 * Named entities real Danish/German/Norwegian sites put in `<title>` and
 * `<meta>` - `T&oslash;mrer`, `Zahn&auml;rzte`. Browsers decode the full HTML5
 * table; we only ever read metadata strings, so Latin-1 letters plus the
 * punctuation CMSs emit is enough.
 */
const NAMED_ENTITIES = new Map(
	Object.entries({
		amp: '&',
		lt: '<',
		gt: '>',
		quot: '"',
		apos: "'",
		nbsp: ' ',
		aelig: 'æ',
		AElig: 'Æ',
		oslash: 'ø',
		Oslash: 'Ø',
		aring: 'å',
		Aring: 'Å',
		auml: 'ä',
		Auml: 'Ä',
		ouml: 'ö',
		Ouml: 'Ö',
		uuml: 'ü',
		Uuml: 'Ü',
		szlig: 'ß',
		aacute: 'á',
		Aacute: 'Á',
		eacute: 'é',
		Eacute: 'É',
		iacute: 'í',
		oacute: 'ó',
		uacute: 'ú',
		agrave: 'à',
		egrave: 'è',
		ugrave: 'ù',
		acirc: 'â',
		ecirc: 'ê',
		ocirc: 'ô',
		ccedil: 'ç',
		ntilde: 'ñ',
		atilde: 'ã',
		otilde: 'õ',
		ndash: '–',
		mdash: '—',
		hellip: '…',
		lsquo: '‘',
		rsquo: '’',
		ldquo: '“',
		rdquo: '”',
		laquo: '«',
		raquo: '»',
		bull: '•',
		middot: '·',
		copy: '©',
		reg: '®',
		trade: '™',
		deg: '°',
		euro: '€',
		pound: '£',
		sup2: '²',
		sup3: '³',
		frac12: '½',
		frac14: '¼',
		times: '×',
		shy: ''
	})
)

const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi

function decodeNumeric(body: string) {
	const codePoint = body.startsWith('#x')
		? Number.parseInt(body.slice(2), 16)
		: Number.parseInt(body.slice(1), 10)
	if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
		return null
	}
	try {
		return String.fromCodePoint(codePoint)
	} catch {
		return null
	}
}

/** Decode the entities that appear in HTML metadata; unknown ones stay verbatim. */
export function decodeHtmlEntities(value: string) {
	if (!value.includes('&')) return value
	return value.replace(ENTITY_RE, (match, body: string) => {
		if (body.startsWith('#')) return decodeNumeric(body) ?? match
		// Map, not an object literal: `&constructor;` on a plain record resolves
		// through `Object.prototype` and would splice a function into a title.
		return (
			NAMED_ENTITIES.get(body) ??
			NAMED_ENTITIES.get(body.toLowerCase()) ??
			match
		)
	})
}
