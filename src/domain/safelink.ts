// Outlook rewrites every link in inbound mail to point at a scanner of its own, carrying the real
// destination in a `url` parameter and appending a per-recipient tracking blob after it. Measured
// across one seven-day vault: 98 links, 49,637 bytes of wrapper around 8,903 bytes of destination,
// a third of everything the mailbox had written. Neither a reader nor an agent can see where a link
// goes, and one line of a Teams notification ran past six hundred characters.
//
// Unwrapping means a click from the vault reaches the destination without passing through the
// scanner. That is the trade, taken deliberately: this is an archive of what was sent, and what was
// sent is the destination. The wrapper is Microsoft's delivery mechanism, not the sender's link.
// The path between the host and the query is not always empty: a link inside a Teams notification
// arrives as `.../ap/t-59584e83/?url=…`, and a pattern demanding `.com/?` walked straight past
// twelve of them.
const WRAPPED = /https?:\/\/[a-z0-9-]+\.safelinks\.protection\.outlook\.com\/[^\s?)<>\]]*\?[^\s)<>\]]*/gi;

// Everything up to the next parameter. What follows is `data`, `sdata` and `reserved`: a signature
// over the recipient and the tenant, which says nothing about where the link points.
const DESTINATION = /[?&]url=([^&]*)/;

// `decodeURIComponent` throws on a percent sign that opens no valid escape, and domain code does not
// catch. A wrapper carrying one is left exactly as it stands, which is the answer that loses least.
const MALFORMED = /%(?![0-9a-fA-F]{2})/;

export const unwrapSafelinks = (text: string): string =>
  text.replace(WRAPPED, (wrapper) => {
    const encoded = DESTINATION.exec(wrapper)?.[1];
    return encoded === undefined || encoded.length === 0 || MALFORMED.test(encoded) ? wrapper : decodeURIComponent(encoded);
  });
