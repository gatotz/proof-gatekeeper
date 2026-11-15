// Minimal typings for the snarkjs API surface this service uses.
// snarkjs 0.7.6 ships no TypeScript declarations of its own.
declare module "snarkjs" {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }

  export namespace groth16 {
    function fullProve(
      input: Record<string, unknown>,
      wasmPath: string,
      zkeyPath: string,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    function verify(
      vk: unknown,
      publicSignals: string[],
      proof: Groth16Proof,
    ): Promise<boolean>;
  }
}
