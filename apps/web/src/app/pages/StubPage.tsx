interface StubPageProps {
  readonly title: string;
}

export function StubPage({ title }: StubPageProps): JSX.Element {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <p>结构化规划已可用；此页面将在对应的后续子阶段接入确定性核心。</p>
    </section>
  );
}
