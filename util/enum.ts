import type { EnumType } from "./types/Enum";

// https://stackoverflow.com/questions/47867918/declare-a-constructor-to-correctly-infer-generic-type-from-keyof-argument-in-t/48152195#48152195:~:text=UPDATE
interface Enum<T extends readonly PropertyKey[]> { }

interface EnumConstructor {
    new <const T extends readonly PropertyKey[]>(keys: T): EnumType<T>
    new <E extends readonly PropertyKey[]>(keys: E): Enum<E>
}

class _Enum<const T extends readonly PropertyKey[]> {
    constructor(keys: T) {
        for (let x = 0; x < keys.length; x++) {
            this[keys[x]] = x;
            this[x] = keys[x];
        }
    }
}

export const Enum: EnumConstructor = _Enum;

// SEE ALSO: https://www.typescriptlang.org/play/?#code/C4TwDgpgBAqgdgSwPZwCpIJJ2BATgZwgGNhk4AeGAPigF4oAKGKCADxzgBN9YoB+RqwBcsAJR0aANyQJOUEXAiS84th26CRCOADM8UDONpSZcgRnlRFy3AChQkKAFFWYAIZcAjOVQ16qFnYILh4AgQBvKABtAAUobSgAawgQJB0oVABdEVRYzKgAX0trPABuW1s2MCRcYCgHaCc4AFcAWx9A9R5cCDdOFAAbECgY3CRIWpAAaRSozL9nVw9Ob3gydCwcAmJSFHJw2yhouITk1PSskUiogH14uAy87JHO4I0AAwAScO09XCgAHKvEJWNoAIzwBXe-EBxSU+gKtgKUTOaQyUAAZKDWhDcPMqBVKq4anUiCh8HUmm06FAiAM3PgeFTWlADkcjiiUiJRuM8KAZiBni0cWVDuyxUcyXAKbhmiQagwzvgRD0+oNhjyJvzZplxGz2QadDVGAMIHVWDSAAylKAW8hJFL4AB0prgAHNgAALG2sADUvr1EoNwa9CHwnJA4dYmXy9FYQYNiMTSKgDNZQcUAHcoOQpRT0Wo3t1ev04EMRmMtdMdVRFY6cqIRMyfASDVmc05gRpVaXy5q+dWQHNa0qm43nMLyE4CQVyrY83VhbiePR28yGFEAEQoCCbgA0UE3wEzSH3h69PV3uoqeaQppdSDdDCXeGdO9EpSAA
