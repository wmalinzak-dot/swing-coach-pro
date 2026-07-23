// A practice drill for each fault the engine can detect.
//
// The engine's `tip` says what to feel in the moment; a drill is what you go
// do on the range to groove it. Keyed by fault id so the UI can pair every
// detected fault with a concrete, named drill.

export const DRILLS = {
  'setup-too-upright': {
    name: 'Belt-to-the-wall bow',
    steps: [
      'Stand tall an arm’s length from a wall, club across your hips.',
      'Push your belt buckle back until your rear just touches the wall — that’s your hip hinge.',
      'Let your arms hang; check the shaft points at the ball line. Hit 10 balls keeping the feeling.',
    ],
  },
  'setup-too-bent': {
    name: 'Tall-then-settle',
    steps: [
      'Set up as tall as you can, then bend only until your arms hang free of your thighs.',
      'Feel your weight in the middle of your feet, not your toes.',
      'Rehearse 10 setups in a mirror; over-bending forces an over-the-top move.',
    ],
  },
  'setup-locked-knees': {
    name: 'Bump-and-flex',
    steps: [
      'At address, flex your knees until you can bounce lightly on the balls of your feet.',
      'Imagine sitting onto a tall bar stool — athletic, not squatting.',
      'Hold that flex through 10 slow rehearsals so it becomes your default.',
    ],
  },
  'setup-too-squatty': {
    name: 'Rise-an-inch',
    steps: [
      'From your normal setup, straighten your knees about an inch.',
      'You should still feel springy, but your hips can now turn freely.',
      'Make 10 slow backswings feeling the hips rotate instead of the legs squatting.',
    ],
  },
  'head-sway': {
    name: 'Head-against-the-wall turn',
    steps: [
      'Stand with your trail shoulder a few inches from a wall, head lightly touching it.',
      'Make slow backswings keeping your head in contact — you’ll feel yourself turn, not slide.',
      'Add a ball once you can reach the top without the head drifting off the wall.',
    ],
  },
  'knee-sway': {
    name: 'Braced trail knee',
    steps: [
      'Place a clubshaft or alignment stick just outside your trail knee.',
      'Coil to the top without letting the knee push into the stick.',
      'Feel the pressure load into the inside of your trail foot — that’s a real coil.',
    ],
  },
  'bent-lead-arm': {
    name: 'Wide-arm split',
    steps: [
      'Grip with your hands split a few inches apart.',
      'Swing to the top feeling your lead arm reach for maximum width.',
      'Hit soft shots split-handed, then rejoin your grip keeping the same width.',
    ],
  },
  'flying-elbow': {
    name: 'Headcover under the trail arm',
    steps: [
      'Tuck a towel or headcover between your trail bicep and your chest.',
      'Make backswings keeping it pinned to the top — the elbow now points down.',
      'Drop it and you’ll feel the tray-carry position on your own.',
    ],
  },
  'early-extension': {
    name: 'Chair-behind drill',
    steps: [
      'Set up with a chair or bag just touching your rear.',
      'Swing down keeping your rear against it — no standing up into the ball.',
      'Start at half speed; losing contact means you extended early.',
    ],
  },
  'stalled-hips': {
    name: 'Step-through release',
    steps: [
      'Start the downswing by bumping your lead hip toward the target, then rotate hard.',
      'Let your trail foot step through toward the target after impact.',
      'The step forces your hips to keep clearing instead of stalling.',
    ],
  },
  'no-post': {
    name: 'Post-and-hold',
    steps: [
      'Through impact, straighten (post) your lead leg and hold the finish.',
      'Feel pressure snap into your lead heel as the leg straightens.',
      'Rehearse 10 impact-to-finish moves posting up each time.',
    ],
  },
  'off-balance': {
    name: '80%-hold finish',
    steps: [
      'Swing at 80% effort and freeze your finish for a full three-count.',
      'All your weight should be stacked on your lead foot, trail toe down.',
      'Only add speed once you can hold every finish without a stumble.',
    ],
  },
  'flat-trail-foot': {
    name: 'Laces-to-the-target finish',
    steps: [
      'Make swings that end with your trail heel fully up and laces facing the target.',
      'That proves your weight actually transferred to the lead side.',
      'Exaggerate it — finish on the tip of your trail toe for 10 reps.',
    ],
  },
};

export function drillFor(faultId) {
  return DRILLS[faultId] || null;
}
