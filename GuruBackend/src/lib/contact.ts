// Contact details in free text (bios, cancellation reasons) keep conversations off-platform. The spec pack does not
// include the Admin FR-17.5 regex, so this is a conservative stand-in: phone numbers, emails and links.
const PATTERN_SOURCE = String.raw`(\+?\d[\d\s().-]{7,}\d)|([\w.+-]+@[\w-]+\.[\w.-]+)|(https?:\/\/\S+|www\.\S+)|(\b[\w-]+\.(com|in|org|net|io|co|me|app)\b)`

export const containsContactInfo = (text: string): boolean => new RegExp(PATTERN_SOURCE, 'i').test(text)
export const maskContactInfo = (text: string): string => text.replace(new RegExp(PATTERN_SOURCE, 'gi'), '[hidden]')
