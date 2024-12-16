type UnionToIntersection<U> = (U extends U ? (x: U) => void : never) extends (x: infer I) => void ? I : never
