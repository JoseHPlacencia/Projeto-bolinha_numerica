export function createInputOwnership() {
    let owner = null;

    return {
        claim,
        release
    };

    function claim(source) {
        if (owner !== null && owner !== source) {
            return false;
        }

        owner = source;
        return true;
    }

    function release(source) {
        if (owner === source) {
            owner = null;
        }
    }
}
