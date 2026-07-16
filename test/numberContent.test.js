"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createNumberGenerator,
    getNumberProfile
} = require("../src/content/numberContent");

test("every difficulty generates number labels with at most four characters", () => {
    for (const difficulty of ["easy", "medium", "hard"]) {
        const { profile } = getNumberProfile(difficulty);
        const generateNumber = createNumberGenerator(profile);

        for (let sample = 0; sample < 5000; sample++) {
            const number = generateNumber();

            assert.ok(
                number.display.length <= 4,
                `${difficulty} generated ${number.display}`
            );
        }
    }
});
