import type { UnionToIntersection } from "./UnionToIntersection";

export type EnumType<T extends readonly PropertyKey[]> = UnionToIntersection<{
    [I in keyof T]: {
        [K in T[I]]:
        I extends `${infer I extends number}` ? Record<K, I>
        : never
    }[T[I]]
}[keyof T & number]>
