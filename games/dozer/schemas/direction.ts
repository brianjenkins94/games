// None = 0 so uninitialized TypedArray slots mean "no intent".
export const Direction = {
    None:  0,
    Up:    1,
    Right: 2,
    Down:  3,
    Left:  4,
} as const;
