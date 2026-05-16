const ANGLE_COMPARE_EPSILON = 0.000001;

const MAX_DIRECTIONAL_ACTIONS = 4;

export function getDirectionalActionsAngle(actions, inputActionAngles) {
    const directionalActions = getUniqueDirectionalActions(actions, inputActionAngles);

    if (directionalActions.length === 0) {
        return null;
    }

    if (directionalActions.length === 1) {
        return inputActionAngles[directionalActions[0]];
    }

    if (directionalActions.length === 2) {
        return getTwoActionAngle(directionalActions, inputActionAngles);
    }

    if (directionalActions.length === 3) {
        return getVectorAverageAngle(directionalActions, inputActionAngles);
    }

    return null;
}

export function normalizeAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function getAngleDelta(currentAngle, targetAngle) {
    return normalizeAngle(targetAngle - currentAngle);
}

function getUniqueDirectionalActions(actions, inputActionAngles) {
    const directionalActions = [];

    for (const action of actions) {
        if (
            Number.isFinite(inputActionAngles[action])
            && !directionalActions.includes(action)
            && directionalActions.length < MAX_DIRECTIONAL_ACTIONS
        ) {
            directionalActions.push(action);
        }
    }

    return directionalActions;
}

function getTwoActionAngle(actions, inputActionAngles) {
    const [firstAction, secondAction] = actions;

    if (areActionsOpposite(firstAction, secondAction, inputActionAngles)) {
        return null;
    }

    return getVectorAverageAngle(actions, inputActionAngles);
}

function areActionsOpposite(firstAction, secondAction, inputActionAngles) {
    const angleDistance = Math.abs(getAngleDelta(
        inputActionAngles[firstAction],
        inputActionAngles[secondAction]
    ));

    return Math.abs(angleDistance - Math.PI) <= ANGLE_COMPARE_EPSILON;
}

function getVectorAverageAngle(actions, inputActionAngles) {
    let x = 0;
    let y = 0;

    for (const action of actions) {
        const angle = inputActionAngles[action];
        x += Math.cos(angle);
        y += Math.sin(angle);
    }

    if (Math.hypot(x, y) <= ANGLE_COMPARE_EPSILON) {
        return null;
    }

    return Math.atan2(y, x);
}
