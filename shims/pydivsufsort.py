"""Stand-in for the native `pydivsufsort` package, which has no Pyodide build.

recan only uses it to ask "where does this byte string occur in this corpus?".
This provides the same two calls with the same return shapes, backed by
bytes.find instead of a suffix array. recan's own code is unchanged.
"""


class _Positions(list):
    """Plays the role of the suffix array: indexable by the (count, offset) that
    sa_search returns, yielding the positions of the matches."""


def divsufsort(data):
    return _Positions()


def sa_search(data, sa, needle):
    start = len(sa)
    pos = bytes(data).find(needle) if needle else -1
    hay = bytes(data)
    while pos != -1:
        sa.append(pos)
        pos = hay.find(needle, pos + 1)
    count = len(sa) - start
    return (count, start) if count else (0, None)
